import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startProxy } from "../../js/src/proxy/proxy.ts";
import { launchIsolated, cleanIsolated } from "./isolated.mjs";
import { parseTool } from "./tools.mjs";
import { startBridge } from "./bridge.mjs";

const ordinary = (page) => /^(https?:\/\/|about:blank$)/i.test(page.url());
const secret = () => randomBytes(32).toString("hex");
const log = { log: (...args) => console.error(...args), error: (...args) => console.error(...args) };
async function json(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export class BrowserBroker {
  constructor({
    home,
    extensionId,
    extensionVersion = "0.1.0",
    bridgePort = 29393,
    releaseUrl = "https://github.com/itMrBoy/cdpHelper/releases/tag/v0.1.0",
    connect = (endpoint) => chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 15000 }),
  }) {
    this.home = home;
    this.extensionId = extensionId;
    this.extensionVersion = extensionVersion;
    this.bridgePort = bridgePort;
    this.releaseUrl = releaseUrl;
    this.connect = connect;
    this.sessions = new Map();
    this.instances = new Map();
    this.tabs = new Map();
    this.records = [];
    this.recordsQueue = Promise.resolve();
    this.pendingTokens = new Set();
    this.disposals = new Set();
  }
  async init() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    this.records = await json(path.join(this.home, "retained.json"), []);
    for (const record of this.records) delete record.closing;
    this.bridge = await startBridge({
      port: this.bridgePort,
      extensionId: this.extensionId,
      extensionVersion: this.extensionVersion,
      register: (hello, peer) => this.attach(hello, peer),
      disconnected: (instance) => this.detach(instance),
      initialization: (token) => this.records.some((r) => r.launch_token === token && !r.initialized),
    });
  }
  async saveRecords() {
    this.recordsQueue = this.recordsQueue
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.home, "retained.json");
        await writeFile(
          `${file}.tmp`,
          JSON.stringify(this.records, (key, value) => (key === "closing" ? undefined : value), 2),
          { mode: 0o600 },
        );
        await rename(`${file}.tmp`, file);
      });
    return this.recordsQueue;
  }
  createSession() {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      instance: null,
      pending: null,
      isolation: null,
      lastSeen: Date.now(),
      queue: Promise.resolve(),
      active: 0,
    });
    return id;
  }
  heartbeat(id) {
    const session = this.session(id);
    session.lastSeen = Date.now();
  }
  session(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Session expired. Start a new MCP session.");
    return s;
  }
  async dropSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.queue.catch(() => {});
    for (const tab of this.tabs.values()) if (tab.owner === id) tab.owner = null;
    this.sessions.delete(id);
  }
  async call(id, name, input) {
    const args = parseTool(name, input);
    const session = this.session(id);
    session.lastSeen = Date.now();
    session.active++;
    const operation = session.queue.catch(() => {}).then(() => this.execute(session, name, args));
    session.queue = operation;
    try {
      return await operation;
    } finally {
      session.active--;
      session.lastSeen = Date.now();
    }
  }
  async attach(hello, peer) {
    const record = hello.launch_token && this.records.find((r) => r.launch_token === hello.launch_token);
    if (hello.launch_token && !record)
      throw new Error("Unknown isolated launch token; no existing browser was selected.");
    if (record?.closing) throw new Error("Isolated instance cleanup is in progress.");
    if (
      record &&
      (this.pendingTokens.has(hello.launch_token) || [...this.instances.values()].some((i) => i.record === record))
    )
      throw new Error("An extension is already connected for this isolated instance.");
    if (record) this.pendingTokens.add(hello.launch_token);
    let proxy;
    try {
      const token = secret();
      proxy = await startProxy({
        proxy_listen_port: 0,
        proxy_client_token: secret(),
        launcher: { launcher_mode: "none" },
        injector: { injector_mode: "none" },
        logger: log,
        upstream: {
          upstream_mode: "reversews",
          upstream_reversews_bind: "127.0.0.1:0",
          upstream_reversews_token: token,
          upstream_reversews_replace_peer: false,
        },
      });
      let key, short;
      do {
        key = randomUUID();
        short = key.replaceAll("-", "").slice(0, 8);
      } while ([...this.instances.values()].some((i) => i.short === short));
      const instance = {
        key,
        short,
        name: hello.name?.trim() || "Snow " + short,
        proxy,
        record,
        peer,
        browser: null,
        connecting: null,
      };
      this.instances.set(key, instance);
      if (record) {
        // Only a pending launch can acquire its first connection automatically.
        // Reconnected peers always get fresh IDs and require explicit selection.
        for (const session of this.sessions.values()) {
          if (session.pending === record.instance_id) {
            session.pending = null;
            session.instance = key;
          }
        }
        record.initialized = true;
        record.last_connection_id = key;
        await this.saveRecords();
      }
      instance.endpoint = proxy.status().reverse_endpoint + "?token=" + token;
      instance.registration = {
        type: "snow.bridge.registered",
        instance_id: key,
        short_id: short,
        name: instance.name,
        owned: Boolean(record),
      };
      return instance;
    } catch (error) {
      await proxy?.close();
      throw error;
    } finally {
      if (record) this.pendingTokens.delete(hello.launch_token);
    }
  }
  async detach(instance) {
    if (instance.disposing) return instance.disposing;
    this.instances.delete(instance.key);
    for (const [id, tab] of this.tabs) if (tab.instance === instance.key) this.tabs.delete(id);
    const disposing = (async () => {
      instance.peer?.close();
      await instance.browser?.close().catch(() => {});
      await instance.proxy.close().catch(() => {});
    })();
    instance.disposing = disposing;
    this.disposals.add(disposing);
    try {
      await disposing;
    } finally {
      this.disposals.delete(disposing);
    }
  }
  describe(instance) {
    return {
      instance_id: instance.key,
      short_id: instance.short,
      name: instance.name,
      mode: instance.record ? "isolated" : "reuse",
      ...(instance.record ? { owned_instance_id: instance.record.instance_id } : {}),
      proxy_listening: instance.proxy.status().listening,
      extension_connected: instance.proxy.status().extension_connected,
      playwright_connected: Boolean(instance.browser?.isConnected()),
    };
  }
  pending(session) {
    const record = this.records.find((r) => r.instance_id === session.pending);
    return record
      ? {
          owned_instance_id: record.instance_id,
          profile: record.profile,
          pid: record.pid,
          state: "waiting_for_extension",
          setup:
            "Enable the matching Release extension in the new Snow window and keep its initialization tab open. No other browser is selected.",
          release_url: this.releaseUrl,
        }
      : null;
  }
  async ensureBrowser(instance) {
    if (instance.browser?.isConnected()) return instance.browser;
    for (
      let attempt = 0;
      !instance.proxy.status().extension_connected && this.instances.has(instance.key) && attempt < 20;
      attempt++
    )
      await delay(25);
    if (!instance.proxy.status().extension_connected)
      throw new Error(
        `The selected Snow extension is not connected. Enable the matching cdpHelper Release extension in the intended window; no browser fallback was attempted.`,
      );
    if (!instance.connecting)
      instance.connecting = this.connect(instance.proxy.cdp_url)
        .then(async (browser) => {
          if (this.instances.get(instance.key) !== instance || instance.disposing) {
            await browser.close().catch(() => {});
            throw new Error("Browser disconnected while Playwright was connecting. Select a current instance.");
          }
          instance.browser = browser;
          browser.on("disconnected", () => {
            instance.browser = null;
            for (const [id, tab] of this.tabs) if (tab.instance === instance.key) this.tabs.delete(id);
          });
          const context = browser.contexts()[0];
          if (!context) throw new Error("The selected browser has no default context.");
          context.setDefaultTimeout(10000);
          context.setDefaultNavigationTimeout(15000);
          return browser;
        })
        .finally(() => {
          instance.connecting = null;
        });
    return instance.connecting;
  }
  async context(session) {
    if (!session.instance)
      throw new Error(
        "List browser_status and ask the user to select an existing instance or start an isolated instance with browser_select first.",
      );
    const instance = this.instances.get(session.instance);
    if (!instance) throw new Error("Browser instance is no longer attached. Select a browser again.");
    const browser = await this.ensureBrowser(instance);
    return browser.contexts()[0];
  }
  register(page, instance) {
    for (const [id, tab] of this.tabs) if (tab.page === page) return id;
    const id = randomUUID();
    this.tabs.set(id, { page, instance, owner: null });
    page.once("close", () => this.tabs.delete(id));
    return id;
  }
  owned(session, id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.instance !== session.instance || tab.page.isClosed())
      throw new Error("Tab reference expired or belongs to a different browser.");
    if (tab.owner !== session.id) throw new Error("Tab is not bound to this session. Bind an available tab first.");
    if (!ordinary(tab.page)) throw new Error("Internal/non-web pages are not operated by this plugin.");
    return tab.page;
  }
  locator(page, target) {
    if (target.role) return page.getByRole(target.role, { name: target.name, exact: true });
    if (target.label) return page.getByLabel(target.label, { exact: true });
    return page.locator(target.selector);
  }
  async execute(session, name, args) {
    if (name === "browser_status")
      return {
        selected: session.instance,
        instances: [...this.instances.values()].map((i) => this.describe(i)),
        pending_isolation: this.pending(session),
        retained: this.records
          .filter((r) => ![...this.sessions.values()].some((s) => s.isolation === r.instance_id))
          .map((r) => ({ instance_id: r.instance_id, profile: r.profile, pid: r.pid })),
        selection_required: !this.instances.has(session.instance) && !session.pending,
        bridge: { listening: true, endpoint: "ws://127.0.0.1:" + this.bridge.port + "/bridge", protocol_version: 2 },
        setup:
          "Download the matching extension Release separately, unzip it, and manually load extension/ in the target Snow window, or enable its profile-distributed copy. The plugin never installs or copies extensions.",
        release_url: this.releaseUrl,
      };
    if (name === "browser_select") {
      if (session.instance === args.instance_id && args.mode === "reuse") {
        const current = this.instances.get(session.instance);
        if (!current) throw new Error("Selected instance disconnected; list and choose a current instance.");
        return this.describe(current);
      }
      if (session.pending) {
        if (args.mode === "isolated") return { pending_isolation: this.pending(session) };
        throw new Error(
          "Ask whether to close/clean the pending isolated instance and call browser_finish before switching.",
        );
      }
      if (session.isolation)
        throw new Error(
          "Ask whether to close/clean the current isolated instance and call browser_finish before switching.",
        );
      if (args.mode === "reuse") {
        const instance = this.instances.get(args.instance_id);
        if (!instance)
          throw new Error(
            "Instance is not connected. List browser_status and select an existing instance; no fallback was attempted.",
          );
        if (instance.record?.closing) throw new Error("Isolated instance cleanup is in progress.");
        for (const tab of this.tabs.values()) if (tab.owner === session.id) tab.owner = null;
        session.instance = instance.key;
        session.isolation = instance.record?.instance_id ?? null;
        return this.describe(instance);
      }
      const key = randomUUID();
      const token = secret();
      // Register the nonce before spawning: a pre-distributed extension may connect immediately.
      const launch = { instance_id: key, launch_token: token, creator_session_id: session.id, initialized: false };
      this.records.push(launch);
      session.pending = key;
      session.isolation = key;
      for (const tab of this.tabs.values()) if (tab.owner === session.id) tab.owner = null;
      session.instance = null;
      try {
        const { record } = await launchIsolated(
          this.home,
          key,
          args.executable,
          "http://127.0.0.1:" + this.bridge.port + "/initialize/" + token,
        );
        Object.assign(launch, record);
        await this.saveRecords();
      } catch (error) {
        this.records = this.records.filter((r) => r !== launch);
        session.pending = null;
        session.isolation = null;
        await this.saveRecords();
        throw error;
      }
      return session.instance
        ? this.describe(this.instances.get(session.instance))
        : { pending_isolation: this.pending(session) };
    }
    if (name === "browser_cleanup_retained") {
      if ([...this.sessions.values()].some((s) => s.isolation === args.instance_id))
        throw new Error("Instance is still attached to an active session; use browser_finish there.");
      return this.cleanup(args.instance_id);
    }
    if (name === "browser_finish") {
      const record = this.records.find((r) => r.instance_id === session.isolation);
      if (args.close_and_cleanup && record) {
        if (record.creator_session_id !== session.id)
          throw new Error(
            "This session did not create that isolated instance. Release it and use confirmed retained cleanup instead.",
          );
        if ([...this.sessions.values()].some((s) => s.id !== session.id && s.isolation === record.instance_id))
          throw new Error("Another session is using this isolated instance. Release its selection before cleanup.");
        await this.cleanup(record.instance_id);
      }
      for (const tab of this.tabs.values()) if (tab.owner === session.id) tab.owner = null;
      const key = session.instance ?? session.pending;
      session.instance = null;
      session.pending = null;
      session.isolation = null;
      return { released: true, browser_preserved: !(args.close_and_cleanup && record), instance_id: key };
    }
    const context = await this.context(session);
    if (name === "browser_tabs")
      return {
        tabs: await Promise.all(
          context
            .pages()
            .filter(ordinary)
            .map(async (page) => {
              const id = this.register(page, session.instance);
              const tab = this.tabs.get(id);
              const title = await Promise.race([page.title(), delay(3000).then(() => "<title timeout>")]).catch(
                () => "<unavailable>",
              );
              return {
                tab_id: id,
                url: page.url(),
                title,
                ownership: tab.owner === session.id ? "mine" : tab.owner ? "busy" : "available",
              };
            }),
        ),
      };
    if (name === "browser_new_tab") {
      const page = await context.newPage();
      const id = this.register(page, session.instance);
      this.tabs.get(id).owner = session.id;
      return { tab_id: id };
    }
    if (name === "browser_bind") {
      const tab = this.tabs.get(args.tab_id);
      if (!tab || tab.instance !== session.instance || tab.page.isClosed())
        throw new Error("Invalid tab for selected browser.");
      if (tab.owner && tab.owner !== session.id) throw new Error("Tab is busy in another session.");
      tab.owner = session.id;
      return { bound: args.tab_id };
    }
    const page = this.owned(session, args.tab_id);
    if (name === "browser_release") {
      this.tabs.get(args.tab_id).owner = null;
      return { released: args.tab_id };
    }
    if (name === "browser_navigate") {
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { url: page.url() };
    }
    if (name === "browser_snapshot")
      return {
        url: page.url(),
        title: await page.title(),
        snapshot: (await page.locator("body").ariaSnapshot({ timeout: 10000 })).slice(0, 50000),
      };
    if (name === "browser_screenshot") return { image: (await page.screenshot({ timeout: 10000 })).toString("base64") };
    const locator = this.locator(page, args.target);
    if (name === "browser_click") await locator.click();
    else if (name === "browser_fill") await locator.fill(args.value);
    else if (name === "browser_press") await locator.press(args.key);
    else if (name === "browser_wait") await locator.waitFor({ state: args.state, timeout: args.timeout_ms });
    return { completed: name, url: page.url() };
  }
  async cleanup(id) {
    const record = this.records.find((r) => r.instance_id === id);
    if (!record) throw new Error("Unknown retained instance.");
    if (record.closing) throw new Error("Isolated instance cleanup is already in progress.");
    record.closing = true;
    try {
      await cleanIsolated(this.home, record);
      for (const instance of [...this.instances.values()]) if (instance.record === record) await this.detach(instance);
      this.records = this.records.filter((r) => r.instance_id !== id);
      await this.saveRecords();
    } finally {
      delete record.closing;
    }
    return { closed_and_cleaned: id };
  }
  async close() {
    await this.bridge?.close();
    await Promise.all([...this.instances.values()].map((i) => this.detach(i)));
    await Promise.allSettled([...this.disposals]);
  }
}

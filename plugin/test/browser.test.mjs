import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { randomUUID, randomBytes } from "node:crypto";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(message);
}

test(
  "same extension in multiple profiles: explicit routing, ownership, parallel operations and reconnect invalidation",
  { timeout: 120000 },
  async () => {
    const executablePath = [
      process.env.SNOW_TEST_BROWSER,
      path.join(homedir(), ".cache/puppeteer/chrome/win64-131.0.6778.204/chrome-win64/chrome.exe"),
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((p) => p && existsSync(p));
    assert.ok(
      executablePath,
      "Set SNOW_TEST_BROWSER to an installed extension-capable Chromium. Real Snow acceptance is separate.",
    );
    const scratch = await mkdtemp(path.join(tmpdir(), "snow-multipeer-fixture-"));
    const bundled = path.resolve(".llmdoc-tmp/plugin-tests/broker.mjs");
    await mkdir(path.dirname(bundled), { recursive: true });
    await build({
      entryPoints: ["plugin/src/broker.mjs"],
      outfile: bundled,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const { BrowserBroker } = await import(pathToFileURL(bundled).href);
    const metadata = JSON.parse(
      await readFile("dist/plugin-marketplace/plugins/snow-browser/runtime/build.json", "utf8"),
    );
    const broker = new BrowserBroker({
      home: path.join(scratch, "home"),
      extensionId: metadata.expected_extension_id,
      bridgePort: 0,
      // The late-init record below represents an owned process fixture, not Snow acceptance.
      checkIsolated: async () => true,
    });
    const fixture = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>Snow fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output><button id="late" hidden>Late</button>`,
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const contexts = [];
    try {
      await broker.init();
      const a = broker.createSession(),
        b = broker.createSession(),
        c = broker.createSession();
      await assert.rejects(broker.call(a, "browser_new_tab", {}), /select|choose/i);
      await assert.rejects(broker.call(a, "browser_select", { mode: "reuse" }));
      const extension = path.resolve("dist/extension");
      for (const alias of ["Profile A", "Profile B"]) {
        const context = await chromium.launchPersistentContext(path.join(scratch, alias), {
          executablePath,
          headless: true,
          args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
          ],
        });
        contexts.push(context);
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
        await until(
          () => worker.evaluate(() => Boolean(chrome.storage?.local)),
          "Extension APIs must be initialized before profile configuration",
        );
        await worker.evaluate(
          async ({ url, alias }) => {
            await chrome.storage.local.set({ snowBridgeUrl: url, snowInstanceName: alias });
            setTimeout(() => chrome.runtime.reload(), 50);
          },
          { url: `ws://127.0.0.1:${broker.bridge.port}/bridge`, alias },
        );
      }
      const inventory = await until(async () => {
        const status = await broker.call(a, "browser_status", {});
        return (
          status.instances.length === 2 && status.instances.every((i) => i.extension_connected) && status.instances
        );
      }, "Both profiles must register independently with the same extension ID");
      const ia = inventory.find((i) => i.name === "Profile A"),
        ib = inventory.find((i) => i.name === "Profile B");
      assert.ok(ia && ib);
      assert.notEqual(ia.instance_id, ib.instance_id);
      assert.notEqual(ia.short_id, ib.short_id);
      assert.equal(
        (await broker.call(a, "browser_status", {})).selected,
        null,
        "registration must not select implicitly",
      );
      await broker.call(a, "browser_select", { mode: "reuse", instance_id: ia.instance_id });
      await broker.call(b, "browser_select", { mode: "reuse", instance_id: ib.instance_id });
      await broker.call(c, "browser_select", { mode: "reuse", instance_id: ia.instance_id });
      assert.equal((await fetch(broker.instances.get(ia.instance_id).proxy.url + "/json/version")).status, 403);
      const first = await broker.call(a, "browser_new_tab", {});
      const second = await broker.call(b, "browser_new_tab", {});
      const third = await broker.call(c, "browser_new_tab", {});
      const url = `http://127.0.0.1:${fixture.address().port}/`;
      await Promise.all([
        broker.call(a, "browser_navigate", { ...first, url }),
        broker.call(b, "browser_navigate", { ...second, url }),
        broker.call(c, "browser_navigate", { ...third, url }),
      ]);
      await assert.rejects(broker.call(c, "browser_bind", first), /busy/);
      await assert.rejects(broker.call(b, "browser_bind", first), /Invalid|different|expired/i);
      await assert.rejects(
        broker.call(c, "browser_fill", { ...first, target: { label: "Name" }, value: "forged" }),
        /not bound/,
      );
      const original = contexts[0].pages().find((p) => p.url() === url);
      await original.evaluate(() =>
        setTimeout(() => {
          document.querySelector("#late").hidden = false;
        }, 1500),
      );
      let waited = false;
      const waiting = broker
        .call(a, "browser_wait", { ...first, target: { selector: "#late" }, timeout_ms: 5000 })
        .then(() => {
          waited = true;
        });
      await broker.call(b, "browser_fill", { ...second, target: { label: "Name" }, value: "other-profile" });
      await broker.call(c, "browser_fill", { ...third, target: { label: "Name" }, value: "same-profile-parallel" });
      assert.equal(waited, false, "one session's wait must not block other instances or tabs");
      await waiting;
      await broker.call(b, "browser_click", { ...second, target: { role: "button", name: "Apply" } });
      assert.match((await broker.call(b, "browser_snapshot", second)).snapshot, /other-profile/);
      assert.ok(Buffer.from((await broker.call(b, "browser_screenshot", second)).image, "base64").length > 100);
      await broker.dropSession(a);
      await broker.call(c, "browser_bind", first);
      const worker = contexts[0].serviceWorkers()[0];
      await worker.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 50);
      });
      const replacement = await until(async () => {
        const status = await broker.call(c, "browser_status", {});
        return status.instances.find(
          (i) => i.name === "Profile A" && i.instance_id !== ia.instance_id && i.extension_connected,
        );
      }, "Reloaded extension must register a new instance ID");
      const after = await broker.call(c, "browser_status", {});
      assert.notEqual(after.selected, replacement.instance_id, "reconnection must not silently rebind a session");
      await assert.rejects(broker.call(c, "browser_snapshot", first), /expired|attached|select|disconnected/i);
      assert.match(
        (await broker.call(b, "browser_snapshot", second)).snapshot,
        /other-profile/,
        "other profile remains operational",
      );
      await broker.call(c, "browser_select", { mode: "reuse", instance_id: replacement.instance_id });
      await assert.rejects(broker.call(c, "browser_bind", first), /Invalid|expired/i);
      // The service worker may start before Snow opens its initialization URL.
      // Exercise that real ordering without spawning or claiming a real Snow process.
      const stale = await broker.call(c, "browser_new_tab", {});
      const pendingSession = broker.createSession();
      const ownedRecord = {
        instance_id: randomUUID(),
        launch_token: randomBytes(32).toString("hex"),
        creator_session_id: pendingSession,
        initialized: false,
        profile: path.join(scratch, "late-init-fixture-profile"),
        pid: null,
      };
      broker.records.push(ownedRecord);
      Object.assign(broker.session(pendingSession), {
        instance: null,
        pending: ownedRecord.instance_id,
        isolation: ownedRecord.instance_id,
      });
      const initializationTab = await contexts[0].newPage();
      await initializationTab.goto(`http://127.0.0.1:${broker.bridge.port}/initialize/${ownedRecord.launch_token}`);
      const ownedInstance = await until(async () => {
        const status = await broker.call(pendingSession, "browser_status", {});
        return status.instances.find((i) => i.owned_instance_id === ownedRecord.instance_id && i.extension_connected);
      }, "An initialization URL opened after worker startup must register the matching isolated instance");
      assert.notEqual(ownedInstance.instance_id, replacement.instance_id);
      assert.equal(ownedInstance.mode, "isolated");
      const matched = await broker.call(pendingSession, "browser_status", {});
      assert.equal(matched.selected, ownedInstance.instance_id);
      assert.equal(matched.pending_isolation, null);
      await assert.rejects(broker.call(c, "browser_snapshot", stale), /expired|attached|select|disconnected/i);
      assert.match((await broker.call(b, "browser_snapshot", second)).snapshot, /other-profile/);
      await pause(500);
      const stable = await broker.call(pendingSession, "browser_status", {});
      assert.equal(
        stable.selected,
        ownedInstance.instance_id,
        "the initialization tab must not cause repeated worker reloads",
      );
      assert.equal(stable.instances.filter((i) => i.owned_instance_id === ownedRecord.instance_id).length, 1);
      await broker.call(pendingSession, "browser_finish", { close_and_cleanup: false, confirmed_by_user: true });
      await broker.close();
      for (const context of contexts)
        assert.ok(
          context.pages().some((p) => p.url() === url),
          "broker disconnect preserves existing pages",
        );
    } finally {
      await broker.close();
      await Promise.all(contexts.map((c) => c.close()));
      await new Promise((resolve) => fixture.close(resolve));
      const resolved = path.resolve(scratch);
      assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(resolved, { recursive: true, force: true });
    }
  },
);

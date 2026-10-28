// MODCDP_TS_ONLY: Browser extension API implementation, not a simulated backend.
import type { cdp } from "../types/generated/cdp.js";
import type { CdpEventMessage, ProtocolResult } from "../types/modcdp.js";
import type { ChromeDebuggerUpstreamTransport } from "../transport/ChromeDebuggerUpstreamTransport.js";

type TargetInfo = cdp.types.ts.Target.TargetInfo;
type Session = {
  id: string;
  parent: string | null;
  target: TargetInfo;
  debuggee: chrome.debugger.DebuggerSession;
  automatic: boolean;
};
type AttachOptions = cdp.types.ts.Target.SetAutoAttachParams;

/** Implements a browser CDP endpoint over real tab-scoped debugger sessions.
 * Public session IDs belong to one frontend connection. Native child IDs stay
 * scoped to their original root tab; they are never used as standalone targets.
 * Unsupported browser operations fail rather than returning empty successes.
 */
export class ChromeDebuggerCDPAdapter {
  private readonly sessions = new Map<string, Session>();
  private readonly browserSessions = new Set<string>();
  private readonly owned = new Map<string, chrome.debugger.Debuggee>();
  private readonly attaching = new Map<string, Promise<string>>();
  private readonly autoAttach = new Map<string | null, AttachOptions>();
  private readonly discovering = new Map<string | null, cdp.types.ts.Target.TargetFilter | undefined>();
  private known = new Map<string, TargetInfo>();
  private started = false;
  private resetPromise: Promise<void> = Promise.resolve();
  private readonly browserTarget: TargetInfo = {
    targetId: "modcdp-browser",
    type: "browser",
    title: "ModCDP",
    url: "",
    attached: true,
    canAccessOpener: false,
  };

  constructor(
    private readonly upstream: ChromeDebuggerUpstreamTransport,
    private readonly emit: (event: CdpEventMessage) => void,
  ) {}

  private event(method: string, params: Record<string, unknown>, sessionId: string | null = null) {
    this.emit({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private start() {
    if (this.started) return;
    this.started = true;
    chrome.debugger.onEvent.addListener((source, method, params) =>
      this.onEvent(source, method, (params ?? {}) as Record<string, unknown>),
    );
    chrome.debugger.onDetach.addListener((source) => {
      for (const session of [...this.sessions.values()]) {
        if (this.sameRoot(source, session.debuggee)) this.forget(session.id);
      }
      this.owned.delete(this.rootKey(source));
    });
    const refresh = () => {
      void this.refresh().catch((error) => console.error("ModCDP target discovery:", error));
    };
    chrome.tabs.onCreated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    chrome.tabs.onRemoved.addListener(refresh);
  }

  private rootKey(debuggee: chrome.debugger.Debuggee) {
    return JSON.stringify(
      typeof debuggee.tabId === "number" ? { tabId: debuggee.tabId } : { targetId: debuggee.targetId },
    );
  }

  private sameRoot(a: chrome.debugger.Debuggee, b: chrome.debugger.Debuggee) {
    return this.rootKey(a) === this.rootKey(b);
  }

  private matches(target: TargetInfo, filter?: cdp.types.ts.Target.TargetFilter) {
    if (!filter) return target.type === "page";
    const match = filter.find((entry) => !entry.type || entry.type === target.type);
    return match != null && match.exclude !== true;
  }

  private async targets() {
    // Internal browser/DevTools/other-extension pages cannot be attached through
    // this API. Ordinary documents, blank tabs, and file pages remain visible.
    const tabs = await chrome.tabs.query({});
    const normalTabs = new Set(tabs.filter((tab) => !tab.incognito).map((tab) => tab.id));
    const nativeTargets = await chrome.debugger.getTargets();
    const accessible = new Set(
      nativeTargets.filter((target) => normalTabs.has(target.tabId)).map((target) => target.id),
    );
    return (await this.upstream.getTargets())
      .filter(
        (target) =>
          accessible.has(target.targetId) &&
          target.type === "page" &&
          /^(https?:|file:|about:blank(?:[?#]|$))/.test(target.url),
      )
      .map((target) => ({ ...target, browserContextId: "modcdp-default" }));
  }

  private async refresh() {
    if (!this.autoAttach.size && !this.discovering.size) return;
    const targets = await this.targets();
    const previous = this.known;
    this.known = new Map(targets.map((target) => [target.targetId, target]));
    for (const target of targets) {
      const old = previous.get(target.targetId);
      for (const session of this.sessions.values()) {
        if (session.target.targetId === target.targetId) session.target = target;
      }
      for (const [parent, filter] of this.discovering) {
        if (!this.matches(target, filter)) continue;
        if (!old) this.event("Target.targetCreated", { targetInfo: target }, parent);
        else if (old.url !== target.url || old.title !== target.title)
          this.event("Target.targetInfoChanged", { targetInfo: target }, parent);
      }
      for (const [parent, options] of this.autoAttach) {
        if (options.autoAttach && this.matches(target, options.filter)) await this.attach(target, parent, true);
      }
    }
    for (const [targetId] of previous) {
      if (this.known.has(targetId)) continue;
      for (const session of [...this.sessions.values()]) {
        if (session.target.targetId === targetId) this.forget(session.id);
      }
      for (const parent of this.discovering.keys()) this.event("Target.targetDestroyed", { targetId }, parent);
    }
  }

  private async attach(target: TargetInfo, parent: string | null, automatic: boolean): Promise<string> {
    const key = JSON.stringify([target.targetId, parent, automatic]);
    if (automatic) {
      const existing = [...this.sessions.values()].find(
        (s) => s.automatic && s.parent === parent && s.target.targetId === target.targetId,
      );
      if (existing) return existing.id;
      const pending = this.attaching.get(key);
      if (pending) return pending;
    }
    const attaching = (async () => {
      const { debuggee, owned } = await this.upstream.attachForCDP(target.targetId);
      if (owned) this.owned.set(this.rootKey(debuggee), debuggee);
      const id = crypto.randomUUID();
      this.sessions.set(id, { id, parent, target, debuggee, automatic });
      this.event(
        "Target.attachedToTarget",
        { sessionId: id, targetInfo: { ...target, attached: true }, waitingForDebugger: false },
        parent,
      );
      return id;
    })();
    this.attaching.set(key, attaching);
    try {
      return await attaching;
    } finally {
      this.attaching.delete(key);
    }
  }

  private onEvent(source: chrome.debugger.DebuggerSession, method: string, params: Record<string, unknown>) {
    const parents = [...this.sessions.values()].filter(
      (s) => this.sameRoot(s.debuggee, source) && s.debuggee.sessionId === source.sessionId,
    );
    for (const parent of parents) {
      if (method === "Target.attachedToTarget") {
        const nativeId = String(params.sessionId);
        const id = crypto.randomUUID();
        const target = params.targetInfo as TargetInfo;
        this.sessions.set(id, {
          id,
          parent: parent.id,
          target,
          automatic: true,
          debuggee: { ...source, sessionId: nativeId },
        });
        void this.publishChild(parent, id, params).catch((error) => console.error("ModCDP child target:", error));
      } else if (method === "Target.detachedFromTarget") {
        for (const child of [...this.sessions.values()]) {
          if (child.parent === parent.id && child.debuggee.sessionId === params.sessionId) this.forget(child.id);
        }
      } else this.event(method, params, parent.id);
    }
  }

  private async publishChild(parent: Session, id: string, params: Record<string, unknown>) {
    const child = this.sessions.get(id)!;
    if (child.target.type === "iframe" && !child.target.parentFrameId) {
      // Older Chromium omits OOPIFs from the parent's frame tree and does not
      // include parentFrameId in TargetInfo. Read its real parent from the child
      // frame before publishing the attachment, otherwise clients ignore it.
      const result = await this.upstream.sendForCDP(child.debuggee, "Page.getFrameTree");
      const frame = (result.frameTree as cdp.types.ts.Page.FrameTree).frame;
      if (!frame.parentId) throw new Error(`Missing parent frame for iframe ${child.target.targetId}.`);
      child.target = { ...child.target, parentFrameId: frame.parentId };
    }
    if (this.sessions.has(id))
      this.event("Target.attachedToTarget", { ...params, targetInfo: child.target, sessionId: id }, parent.id);
  }

  private forget(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const child of [...this.sessions.values()]) if (child.parent === id) this.forget(child.id);
    this.sessions.delete(id);
    this.event("Target.detachedFromTarget", { sessionId: id, targetId: session.target.targetId }, session.parent);
  }

  private async detach(id: string) {
    if (this.browserSessions.delete(id)) {
      for (const child of [...this.sessions.values()]) if (child.parent === id) await this.detach(child.id);
      this.autoAttach.delete(id);
      this.discovering.delete(id);
      return;
    }
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown CDP session ${id}.`);
    await this.upstream.sendForCDP(session.debuggee, "Runtime.runIfWaitingForDebugger").catch(() => {});
    this.forget(id);
    const remaining = [...this.sessions.values()].filter((s) => this.sameRoot(s.debuggee, session.debuggee));
    if (session.debuggee.sessionId && !remaining.some((s) => s.debuggee.sessionId === session.debuggee.sessionId)) {
      await this.upstream.sendForCDP({ ...session.debuggee, sessionId: undefined }, "Target.detachFromTarget", {
        sessionId: session.debuggee.sessionId,
      });
    }
    const key = this.rootKey(session.debuggee);
    if (!remaining.length && this.owned.has(key)) {
      await this.upstream.detachForCDP(this.owned.get(key)!);
      this.owned.delete(key);
    }
  }

  async reset() {
    this.autoAttach.clear();
    this.discovering.clear();
    this.resetPromise = this.resetPromise.then(async () => {
      await Promise.allSettled([...this.attaching.values()]);
      // Detaching a root releases its debugger and paused children. Do not send
      // Runtime commands to every page first: an unresponsive renderer must not
      // block cleanup or the next frontend connection indefinitely.
      const borrowed = [...this.sessions.values()].filter((s) => !this.owned.has(this.rootKey(s.debuggee)));
      this.sessions.clear();
      this.browserSessions.clear();
      await Promise.allSettled([...this.owned.values()].map((debuggee) => this.upstream.detachForCDP(debuggee)));
      await Promise.allSettled(
        borrowed.map((s) => this.upstream.sendForCDP(s.debuggee, "Runtime.runIfWaitingForDebugger")),
      );
      this.owned.clear();
      this.known.clear();
    });
    await this.resetPromise;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId: string | null = null,
  ): Promise<ProtocolResult> {
    await this.resetPromise;
    this.start();
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const browser = !sessionId || this.browserSessions.has(sessionId);
    if (!browser && !session) throw new Error(`Unknown CDP session ${sessionId}.`);
    if (method === "Target.getTargetInfo") {
      const target = params.targetId
        ? (await this.targets()).find((t) => t.targetId === params.targetId)
        : (session?.target ?? this.browserTarget);
      if (!target) throw new Error(`Unknown target ${params.targetId}.`);
      return { targetInfo: target };
    }
    if (method === "Target.attachToBrowserTarget") {
      const id = crypto.randomUUID();
      this.browserSessions.add(id);
      return { sessionId: id };
    }
    if (method === "Target.attachToTarget") {
      if (params.flatten !== true) throw new Error("Only flattened CDP sessions are supported.");
      const target = (await this.targets()).find((t) => t.targetId === params.targetId);
      if (!target) throw new Error(`Target is unavailable: ${params.targetId}.`);
      return { sessionId: await this.attach(target, sessionId, false) };
    }
    if (method === "Target.detachFromTarget") {
      const id = String(params.sessionId);
      await this.detach(id);
      return {};
    }
    if (browser) {
      switch (method) {
        case "Browser.getVersion": {
          const userAgent = navigator.userAgent;
          const product = userAgent.match(/(?:HeadlessChrome|Chrome)\/[\d.]+/)?.[0];
          if (!product) throw new Error("Browser version unavailable from this environment.");
          // Revision and V8 version are unavailable to extensions; empty means
          // unknown. Never claim the version of a different installed browser.
          return { protocolVersion: "1.3", product, userAgent, revision: "", jsVersion: "" };
        }
        case "Target.getTargets":
          return { targetInfos: await this.targets() };
        case "Target.getBrowserContexts":
          return { browserContextIds: [] };
        case "Target.setDiscoverTargets": {
          if (params.discover)
            this.discovering.set(sessionId, params.filter as cdp.types.ts.Target.TargetFilter | undefined);
          else this.discovering.delete(sessionId);
          this.known.clear();
          await this.refresh();
          return {};
        }
        case "Target.setAutoAttach": {
          if (params.flatten !== true) throw new Error("Only flattened CDP sessions are supported.");
          if (params.autoAttach) this.autoAttach.set(sessionId, params as AttachOptions);
          else {
            this.autoAttach.delete(sessionId);
            for (const s of [...this.sessions.values()])
              if (s.parent === sessionId && s.automatic) await this.detach(s.id);
          }
          await this.refresh();
          return {};
        }
        case "Target.createTarget": {
          if (params.browserContextId && params.browserContextId !== "modcdp-default")
            throw new Error("Creating isolated browser contexts requires native browser CDP.");
          const targetId = await this.upstream.createTarget(String(params.url ?? "about:blank"));
          await this.refresh();
          return { targetId };
        }
        case "Target.closeTarget":
        case "Target.activateTarget": {
          await this.upstream.getTargets();
          const targets = await chrome.debugger.getTargets();
          const target = targets.find((t) => t.id === params.targetId);
          if (target?.tabId == null) throw new Error(`Unknown tab target ${params.targetId}.`);
          if (method === "Target.closeTarget") await chrome.tabs.remove(target.tabId);
          else await chrome.tabs.update(target.tabId, { active: true });
          return method === "Target.closeTarget" ? { success: true } : {};
        }
        default:
          throw new Error(`Browser-scoped ${method} is unavailable through the extension CDP endpoint.`);
      }
    }
    return (await this.upstream.sendForCDP(session!.debuggee, method, params)) ?? {};
  }
}

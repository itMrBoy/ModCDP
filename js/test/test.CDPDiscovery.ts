// Native API boundary fixtures exercise the real adapter and upstream transport.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ChromeDebuggerCDPAdapter } from "../src/server/ChromeDebuggerCDPAdapter.js";
import { ChromeDebuggerUpstreamTransport } from "../src/transport/ChromeDebuggerUpstreamTransport.js";

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: (listener: (...args: any[]) => void) => listeners.add(listener),
    emit: (...args: any[]) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fixture() {
  const state = {
    tabs: [{ id: 1, url: "https://fixture.test/one", title: "one", incognito: false }],
    omitNative: false,
    queries: 0,
    queryHook: null as null | (() => Promise<any[]>),
  };
  const api = {
    tabs: {
      query: async () => {
        state.queries++;
        return state.queryHook ? state.queryHook() : [...state.tabs];
      },
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    debugger: {
      getTargets: async () =>
        state.omitNative
          ? []
          : state.tabs.map((tab) => ({
              id: `target-${tab.id}`,
              tabId: tab.id,
              type: "page",
              title: tab.title,
              url: tab.url,
              attached: false,
            })),
      attach: (_debuggee, _version, callback) => callback(),
      detach: async () => {},
      sendCommand: (_debuggee, _method, _params, callback) => callback({}),
      onEvent: event(),
      onDetach: event(),
    },
    runtime: {},
  };
  vi.stubGlobal("chrome", api);
  const events: { method: string; params: Record<string, unknown> }[] = [];
  const adapter = new ChromeDebuggerCDPAdapter(new ChromeDebuggerUpstreamTransport(), (value) =>
    events.push({ method: value.method, params: value.params as Record<string, unknown> }),
  );
  return { state, api, events, adapter };
}

const enable = (adapter: ChromeDebuggerCDPAdapter) =>
  adapter.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
const drain = enable;
afterEach(() => vi.unstubAllGlobals());

test("overlapping native tab events serialize snapshots without forgetting a newly attached live page", async () => {
  const { state, api, events, adapter } = fixture();
  await enable(adapter);
  let release: (tabs: any[]) => void;
  let entered: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const oldTabs = [...state.tabs];
  state.queryHook = () => {
    state.queryHook = null;
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  api.tabs.onUpdated.emit(1, { status: "loading" });
  await started;
  const before = state.queries;
  state.tabs.push({ id: 2, url: "https://fixture.test/two", title: "two", incognito: false });
  api.tabs.onCreated.emit(state.tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.queries, before, "A newer snapshot must wait for the earlier snapshot/attach/diff operation");
  release(oldTabs);
  await drain(adapter);
  assert.equal(
    events.filter(
      (value) => value.method === "Target.attachedToTarget" && (value.params.targetInfo as any).targetId === "target-2",
    ).length,
    1,
  );
  assert.equal(events.filter((value) => /detachedFromTarget|targetDestroyed/.test(value.method)).length, 0);
  await adapter.reset();
});

test("navigation native-target gaps preserve a live tab, while real tab removal still invalidates its session", async () => {
  const { state, api, events, adapter } = fixture();
  await enable(adapter);
  await adapter.send("Target.setDiscoverTargets", { discover: true });
  const initialSession = events.find((value) => value.method === "Target.attachedToTarget")!.params.sessionId;
  state.omitNative = true;
  state.tabs[0] = { ...state.tabs[0], url: "https://fixture.test/after-navigation", title: "after" };
  api.tabs.onUpdated.emit(1, { status: "loading" });
  await drain(adapter);
  assert.equal(events.filter((value) => /detachedFromTarget|targetDestroyed/.test(value.method)).length, 0);
  const targets = await adapter.send("Target.getTargets");
  assert.equal((targets.targetInfos as any[])[0].url, state.tabs[0].url);
  state.omitNative = false;
  api.tabs.onUpdated.emit(1, { status: "complete" });
  await drain(adapter);
  assert.equal(
    events.filter((value) => value.method === "Target.attachedToTarget").length,
    1,
    "Restored enumeration must reuse the original public session",
  );
  state.tabs = [];
  api.tabs.onRemoved.emit(1, {});
  await drain(adapter);
  assert.equal(
    events.filter((value) => value.method === "Target.detachedFromTarget" && value.params.sessionId === initialSession)
      .length,
    1,
  );
  assert.ok(events.some((value) => value.method === "Target.targetDestroyed" && value.params.targetId === "target-1"));
  await adapter.reset();
});

test("native debugger detach immediately invalidates the affected live page session", async () => {
  const { api, events, adapter } = fixture();
  await enable(adapter);
  const initialSession = events.find((value) => value.method === "Target.attachedToTarget")!.params.sessionId;
  api.debugger.onDetach.emit({ tabId: 1 }, "canceled_by_user");
  assert.equal(
    events.filter((value) => value.method === "Target.detachedFromTarget" && value.params.sessionId === initialSession)
      .length,
    1,
  );
  await assert.rejects(adapter.send("Page.getFrameTree", {}, String(initialSession)), /Unknown CDP session/);
  await adapter.reset();
});

test("target background creation preserves the active tab and keeps default foreground semantics", async () => {
  const { state, api, adapter } = fixture();
  const creations: { url: string; active: boolean }[] = [];
  (api.tabs as any).create = async (options: { url: string; active: boolean }) => {
    creations.push(options);
    const tab = { id: state.tabs.length + 1, url: options.url, title: "created", incognito: false };
    state.tabs.push(tab);
    return tab;
  };
  try {
    await adapter.send("Target.createTarget", { url: "about:blank", background: true });
    await adapter.send("Target.createTarget", { url: "about:blank" });
    assert.deepEqual(creations, [
      { url: "about:blank", active: false },
      { url: "about:blank", active: true },
    ]);
  } finally {
    await adapter.reset();
  }
});

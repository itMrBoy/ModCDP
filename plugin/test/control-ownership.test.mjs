import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const bundled = path.resolve(".llmdoc-tmp/plugin-tests/broker-ownership.mjs");
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

test("backend handover revokes bound controls, queued actions and active diagnostics without closing the page", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cdphelper-handover-control-"));
  let disposed = 0,
    fills = 0,
    finishWait,
    enteredWait;
  const entered = new Promise((r) => {
    enteredWait = r;
  });
  const broker = new BrowserBroker({
    home,
    extensionId: "a".repeat(32),
    controlFactory: async () => ({
      ensure: async () => {},
      update: async () => {},
      dispose: async () => {
        disposed++;
      },
    }),
  });
  const page = Object.assign(new EventEmitter(), {
    url: () => "https://fixture.test/",
    isClosed: () => false,
    close: () => {
      throw new Error("Handover must preserve browser pages");
    },
    locator: () => ({
      boundingBox: async () => null,
      fill: async () => {
        fills++;
      },
      waitFor: () => {
        enteredWait();
        return new Promise((r) => {
          finishWait = r;
        });
      },
    }),
    context: () => ({
      newCDPSession: async () => {
        const cdp = new EventEmitter();
        cdp.detach = async () => {};
        cdp.send = async (method) => {
          if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script" };
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          if (method === "Runtime.evaluate") return { result: { value: { time_origin: 1 } } };
          if (method === "Performance.getMetrics") return { metrics: [] };
          if (method === "Tracing.end") queueMicrotask(() => cdp.emit("Tracing.tracingComplete", { stream: "trace" }));
          if (method === "IO.read") return { data: '{"traceEvents":[]}', eof: true };
          return {};
        };
        return cdp;
      },
    }),
  });
  broker.context = async () => ({});
  const session = broker.createSession(),
    instance = randomUUID();
  broker.session(session).instance = instance;
  const tab_id = broker.register(page, instance);
  try {
    await broker.call(session, "browser_bind", { tab_id });
    const capture = await broker.call(session, "browser_diagnostics_start", { tab_id });
    const trace = await broker.call(session, "browser_performance_trace_start", { tab_id });
    const traceRecord = broker.diagnostics.traces.get(trace.trace_id);
    const captureRecord = broker.diagnostics.captures.get(capture.capture_id);
    const waiting = broker.call(session, "browser_wait", { tab_id, target: { selector: "#late" } });
    const waitCheck = assert.rejects(waiting, /released|stopped|expired/);
    await entered;
    const queued = broker.call(session, "browser_fill", {
      tab_id,
      target: { selector: "input" },
      value: "must not run",
    });
    const queueCheck = assert.rejects(queued, /expired|ended|changed/);
    await broker.close();
    await Promise.all([waitCheck, queueCheck]);
    assert.equal(fills, 0);
    assert.equal(disposed, 1);
    assert.equal(broker.sessions.size, 0);
    assert.equal(broker.tabs.get(tab_id)?.owner ?? null, null);
    assert.equal(captureRecord.state, "stopped");
    assert.notEqual(captureRecord.stop_reason, "requested");
    assert.equal(traceRecord.state, "failed");
    assert.match(traceRecord.error, /interrupted/i);
    assert.equal(page.isClosed(), false);
    await assert.rejects(broker.call(session, "browser_snapshot", { tab_id }), /Session expired/);
  } finally {
    finishWait?.();
    await broker.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("human stop bypasses the queue; return restores a new lease and requires a fresh snapshot", async () => {
  const controls = [];
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-home"),
    extensionId: "a".repeat(32),
    controlFactory: async (_page, { onStop, onReturn }) => {
      const control = {
        ensure: async () => {},
        update: async () => {},
        dispose: async () => {},
        setMode: async () => {},
        onStop,
        onReturn,
      };
      controls.push(control);
      return control;
    },
  });
  const session = broker.createSession(),
    other = broker.createSession(),
    instance = randomUUID();
  broker.session(session).instance = instance;
  broker.session(other).instance = instance;
  let finishWait, enteredWait;
  const entered = new Promise((resolve) => {
    enteredWait = resolve;
  });
  let fills = 0;
  const page = Object.assign(new EventEmitter(), {
    url: () => "https://example.test/",
    isClosed: () => false,
    title: async () => "Fixture",
    locator: () => ({
      ariaSnapshot: async () => "Current page state",
      waitFor: () => {
        enteredWait();
        return new Promise((resolve) => {
          finishWait = resolve;
        });
      },
      boundingBox: async () => null,
      fill: async () => {
        fills++;
      },
    }),
  });
  broker.context = async () => ({});
  const tab_id = broker.register(page, instance);
  try {
    await broker.call(session, "browser_bind", { tab_id });
    const waiting = broker.call(session, "browser_wait", { tab_id, target: { selector: "#late" } });
    const waitCheck = assert.rejects(waiting, /stopped|released/);
    await entered;
    const queued = broker.call(session, "browser_fill", {
      tab_id,
      target: { selector: "input" },
      value: "must-not-run",
    });
    const queueCheck = assert.rejects(queued, /expired|changed/);
    controls[0].onStop();
    await Promise.all([waitCheck, queueCheck]);
    assert.equal(fills, 0);
    assert.equal(broker.tabs.get(tab_id).owner, null);
    await assert.rejects(broker.call(session, "browser_bind", { tab_id }), /user stopped|Explicit/);
    await assert.rejects(broker.call(other, "browser_bind", { tab_id, resume_after_user_stop: true }), /busy/);
    await controls[0].onReturn();
    await assert.rejects(
      broker.call(session, "browser_fill", { tab_id, target: { selector: "input" }, value: "stale" }),
      /browser_snapshot/,
    );
    await broker.call(session, "browser_snapshot", { tab_id });
    finishWait();
    await broker.call(session, "browser_fill", { tab_id, target: { selector: "input" }, value: "new-operation" });
    assert.equal(fills, 1);
    controls[0].onStop();
    assert.equal(broker.tabs.get(tab_id).owner, session, "a stale controller cannot stop a newer lease");
    await assert.rejects(broker.call(other, "browser_bind", { tab_id }), /busy/);
  } finally {
    finishWait?.();
    await broker.close();
  }
});

test("concurrent binds cannot overwrite ownership; indicator failure rolls back the lease", async () => {
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-home"),
    extensionId: "a".repeat(32),
    controlFactory: async () => {
      throw new Error("indicator unavailable");
    },
  });
  const instance = randomUUID(),
    first = broker.createSession(),
    second = broker.createSession();
  broker.session(first).instance = instance;
  broker.session(second).instance = instance;
  broker.context = async () => ({});
  const page = Object.assign(new EventEmitter(), { url: () => "https://example.test/", isClosed: () => false });
  const tab_id = broker.register(page, instance);
  try {
    const results = await Promise.allSettled([
      broker.call(first, "browser_bind", { tab_id }),
      broker.call(second, "browser_bind", { tab_id }),
    ]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.match(results.map((result) => result.reason.message).join(" "), /busy/);
    assert.equal(broker.tabs.get(tab_id).owner, null);
  } finally {
    await broker.close();
  }
});

test("session drop during indicator installation disposes the late controller without acquiring a lease", async () => {
  let ready,
    finish,
    disposed = false;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-home"),
    extensionId: "a".repeat(32),
    controlFactory: () => {
      ready();
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            dispose: async () => {
              disposed = true;
            },
          });
      });
    },
  });
  const owner = broker.createSession(),
    instance = randomUUID();
  broker.session(owner).instance = instance;
  broker.context = async () => ({});
  const page = Object.assign(new EventEmitter(), { url: () => "https://example.test/", isClosed: () => false });
  const tab_id = broker.register(page, instance);
  const binding = broker.call(owner, "browser_bind", { tab_id });
  const rejected = assert.rejects(binding, /expired|stopped/);
  await started;
  await broker.dropSession(owner);
  assert.equal(broker.tabs.get(tab_id).owner, null);
  finish();
  await rejected;
  assert.equal(disposed, true);
  await broker.close();
});

for (const endSession of [false, true]) {
  test(`stop during indicator installation ${endSession ? "still disposes after session end" : "retains user control and supports return"}`, async () => {
    let started, finish;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const installed = new Promise((resolve) => {
      finish = resolve;
    });
    const controls = [];
    const broker = new BrowserBroker({
      home: path.resolve(".llmdoc-tmp/ownership-home"),
      controlFactory: async (_page, options) => {
        const control = {
          ...options,
          modes: [],
          disposed: false,
          ensure: async () => {},
          setMode: async (mode) => {
            control.modes.push(mode);
          },
          dispose: async () => {
            control.disposed = true;
          },
        };
        controls.push(control);
        if (controls.length === 1) {
          started();
          await installed;
        }
        return control;
      },
    });
    broker.context = async () => ({});
    const owner = broker.createSession(),
      instance = randomUUID();
    broker.session(owner).instance = instance;
    const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/", isClosed: () => false });
    const tab_id = broker.register(page, instance);
    try {
      const binding = broker.call(owner, "browser_bind", { tab_id });
      const rejected = assert.rejects(binding, /expired|stopped/);
      await entered;
      controls[0].onStop();
      if (endSession) await broker.dropSession(owner);
      finish();
      await rejected;
      const tab = broker.tabs.get(tab_id);
      assert.equal(tab.owner, null, "install completion cannot restore the revoked lease");
      if (endSession) {
        assert.equal(tab.control, null);
        assert.equal(controls[0].disposed, true);
      } else {
        assert.equal(tab.control, controls[0]);
        assert.equal(tab.suspendedOwner, owner);
        assert.deepEqual(controls[0].modes, ["user"]);
        assert.equal(controls[0].disposed, false);
        await controls[0].onReturn();
        assert.equal(tab.owner, owner);
        assert.equal(tab.needsSnapshot, true);
        assert.equal(controls[0].disposed, true);
      }
    } finally {
      finish();
      await broker.close();
    }
  });
}

test("evaluate timeout returns even when restoring the page indicator is blocked", async () => {
  let restore;
  const blockedRestore = new Promise((resolve) => {
    restore = resolve;
  });
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-home"),
    extensionId: "a".repeat(32),
    controlFactory: async () => ({
      ensure: async () => {},
      update: ({ action }) => (action === null ? blockedRestore : Promise.resolve()),
      dispose: async () => {},
    }),
  });
  const owner = broker.createSession(),
    instance = randomUUID();
  broker.session(owner).instance = instance;
  broker.context = async () => ({});
  const page = Object.assign(new EventEmitter(), {
    url: () => "https://example.test/",
    isClosed: () => false,
    evaluate: () => new Promise(() => {}),
  });
  const tab_id = broker.register(page, instance);
  try {
    await broker.call(owner, "browser_bind", { tab_id });
    const result = await Promise.race([
      broker.call(owner, "browser_evaluate", { tab_id, function: "() => null", timeout_ms: 10 }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Indicator restore blocked the script timeout")), 500);
        timer.unref();
      }),
    ]);
    assert.equal(result.status, "timed_out");
    assert.equal(result.execution_may_continue, true);
  } finally {
    restore();
    await broker.close();
  }
});

test("a return waiting on old disposal cannot overwrite another session after release", async () => {
  let finishDisposal, enteredDisposal;
  const entered = new Promise((resolve) => {
    enteredDisposal = resolve;
  });
  const disposed = new Promise((resolve) => {
    finishDisposal = resolve;
  });
  const controls = [];
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-race-home"),
    controlFactory: async (_page, options) => {
      const index = controls.length;
      const control = {
        ...options,
        ensure: async () => {},
        setMode: async () => {},
        dispose: async () => {
          if (index === 0) {
            enteredDisposal();
            await disposed;
          }
        },
      };
      controls.push(control);
      return control;
    },
  });
  const instance = randomUUID(),
    first = broker.createSession(),
    second = broker.createSession();
  broker.session(first).instance = instance;
  broker.session(second).instance = instance;
  broker.context = async () => ({});
  const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/", isClosed: () => false });
  const tab_id = broker.register(page, instance);
  try {
    await broker.call(first, "browser_bind", { tab_id });
    controls[0].onStop();
    await broker.tabs.get(tab_id).revoking;
    const returning = controls[0].onReturn();
    const rejected = assert.rejects(returning, /changed|stale/);
    await entered;
    await broker.call(first, "browser_release", { tab_id });
    await broker.call(second, "browser_bind", { tab_id, resume_after_user_stop: true });
    finishDisposal();
    await rejected;
    assert.equal(broker.tabs.get(tab_id).owner, second);
  } finally {
    finishDisposal();
    await broker.close();
  }
});

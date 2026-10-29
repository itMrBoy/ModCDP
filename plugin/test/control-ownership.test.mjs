import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

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

test("human stop bypasses a busy queue, invalidates old operations and requires explicit rebind", async () => {
  const controls = [];
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/ownership-home"),
    extensionId: "a".repeat(32),
    controlFactory: async (_page, { onStop }) => {
      const control = { ensure: async () => {}, update: async () => {}, dispose: async () => {}, onStop };
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
    locator: () => ({
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
    await assert.rejects(broker.call(other, "browser_bind", { tab_id }), /user stopped|Explicit/);
    await broker.call(session, "browser_bind", { tab_id, resume_after_user_stop: true });
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PageControl } from "../src/control.mjs";

test("navigation immediately followed by release clears focus emulation even when reapplication never runs", async () => {
  const session = new EventEmitter();
  const focus = [];
  session.send = async (method, params) => {
    if (method === "Emulation.setFocusEmulationEnabled") focus.push(params.enabled);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "init" };
    if (method === "Runtime.evaluate") return { result: { value: true } };
    return {};
  };
  session.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => session }) };
  const control = await PageControl.create(page, { generation: 1, onStop() {} });
  assert.deepEqual(focus, [true]);
  session.emit("Page.frameNavigated", { frame: { id: "main" } });
  await control.dispose();
  assert.equal(focus.at(-1), false);
  assert.equal(session.listenerCount("Page.frameNavigated"), 0);
});

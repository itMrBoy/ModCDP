import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge.mjs";

const extensionId = "a".repeat(32);
function rejectedPeer(port, { origin = `chrome-extension://${extensionId}`, hello } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Peer was not rejected"));
    }, 7000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      resolve(res.statusCode);
    });
    ws.on("error", () => {});
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("bridge rejects web origins, wrong extension identity, obsolete protocol, and unknown initialization URLs", async () => {
  let registered = 0;
  const bridge = await startBridge({
    port: 0,
    extensionId,
    extensionVersion: "0.1.0",
    register: () => {
      registered++;
      throw new Error("Unexpected register");
    },
    disconnected: () => {},
    initialization: () => false,
  });
  try {
    assert.equal(await rejectedPeer(bridge.port, { origin: "https://example.com" }), 403);
    assert.equal(await rejectedPeer(bridge.port, { origin: "chrome-extension://" + "b".repeat(32) }), 403);
    assert.equal(
      await rejectedPeer(bridge.port, {
        hello: { type: "modcdp.reverse.hello", version: 1, extension_version: "0.1.0", extension_id: extensionId },
      }),
      1008,
    );
    assert.equal(
      await rejectedPeer(bridge.port, {
        hello: { type: "modcdp.reverse.hello", version: 2, extension_version: "0.1.0", extension_id: "b".repeat(32) },
      }),
      1008,
    );
    assert.equal(
      await rejectedPeer(bridge.port, {
        hello: { type: "modcdp.reverse.hello", version: 2, extension_version: "0.0.9", extension_id: extensionId },
      }),
      1008,
    );
    assert.equal(registered, 0);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/initialize/${"c".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/`)).status, 404);
  } finally {
    await bridge.close();
  }
});

test("occupied common bridge port fails without taking over another listener", async () => {
  const other = http.createServer((_req, res) => res.end("untouched"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const port = other.address().port;
  try {
    await assert.rejects(
      startBridge({ port, extensionId, register() {}, disconnected() {}, initialization() {} }),
      /No existing process was terminated|EADDRINUSE/,
    );
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "untouched");
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});

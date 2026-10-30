import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { startBridge } from "../src/bridge.mjs";

const extensionId = "a".repeat(32);
test("bridge shutdown completes with a browser connection that has not finished HTTP headers", async () => {
  const bridge = await startBridge({
    port: 0,
    extensionId,
    extensionVersion: "0.1.1",
    register: () => {},
    disconnected: () => {},
    initialization: () => false,
  });
  const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
  socket.on("error", () => {});
  await once(socket, "connect");
  // Browsers may retain a speculative or incomplete HTTP connection while tabs stay open.
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const closing = bridge.close();
  let timer;
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Bridge shutdown waited for browser HTTP traffic")), 1000);
      }),
    ]);
    await closed;
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closing;
  }
});
function rejectedPeer(port, { origin = `chrome-extension://${extensionId}`, hello, onMessage } = {}) {
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
    ws.on("message", (data) => onMessage?.(JSON.parse(data.toString())));
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

test("registration errors distinguish extension identity, protocol and release with bounded redacted diagnostics", async () => {
  const bridge = await startBridge({
    port: 0,
    extensionId,
    extensionVersion: "0.2.1",
    register() {
      throw Error("must not register");
    },
    disconnected() {},
    initialization() {
      return false;
    },
  });
  const hello = {
    type: "modcdp.reverse.hello",
    version: 2,
    extension_id: extensionId,
    extension_version: "0.2.1",
    launch_token: "f".repeat(64),
    name: "private profile",
  };
  try {
    for (const [changes, reason] of [
      [{ extension_id: "b".repeat(32) }, "identity_mismatch"],
      [{ version: 1 }, "protocol_mismatch"],
      [{ extension_version: "0.2.0" }, "extension_update_required"],
    ]) {
      let message;
      assert.equal(
        await rejectedPeer(bridge.port, {
          hello: { ...hello, ...changes },
          onMessage: (value) => {
            message = value;
          },
        }),
        1008,
      );
      assert.equal(message.reason, reason);
      assert.match(message.message, /cdpHelper 浏览器扩展/);
      assert.equal(message.required_extension_version, "0.2.1");
      assert.ok(!JSON.stringify(message).includes(hello.launch_token));
    }
    for (let index = 0; index < 24; index++)
      await rejectedPeer(bridge.port, { hello: { ...hello, extension_version: `0.0.${index}` } });
    assert.equal(bridge.rejections.length, 20);
    const diagnostics = JSON.stringify(bridge.rejections);
    assert.ok(!diagnostics.includes(hello.launch_token));
    assert.ok(!diagnostics.includes(hello.name));
    assert.ok(!diagnostics.includes("/bridge"));
    let pluginIssue;
    await rejectedPeer(bridge.port, {
      hello: { ...hello, extension_version: "0.3.0" },
      onMessage: (value) => {
        pluginIssue = value;
      },
    });
    assert.equal(pluginIssue.component, "cdpHelper plugin");
    assert.equal(pluginIssue.required_action, "plugin_update_or_reload");
    assert.match(pluginIssue.message, /仅重连 MCP/);
    assert.match(pluginIssue.message, /浏览器扩展为 0\.3\.0/);
    assert.ok(!pluginIssue.message.includes("替换文件"));
  } finally {
    await bridge.close();
  }
});

test("one successful profile does not erase another profile's version rejection", async () => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const bridge = await startBridge({
    port: 0,
    extensionId,
    extensionVersion: "0.2.1",
    register: () => ({
      endpoint: `ws://127.0.0.1:${upstream.address().port}`,
      registration: { type: "snow.bridge.registered" },
    }),
    disconnected() {},
    initialization() {
      return false;
    },
  });
  let peer;
  try {
    const hello = { type: "modcdp.reverse.hello", version: 2, extension_id: extensionId, extension_version: "0.2.0" };
    await rejectedPeer(bridge.port, { hello });
    assert.equal(bridge.rejections.length, 1);
    peer = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin: `chrome-extension://${extensionId}` });
    await once(peer, "open");
    const registration = once(peer, "message");
    peer.send(JSON.stringify({ ...hello, extension_version: "0.2.1" }));
    await registration;
    assert.equal(bridge.rejections.length, 1);
  } finally {
    peer?.terminate();
    await bridge.close();
    for (const connection of upstream.clients) connection.terminate();
    await new Promise((resolve) => upstream.close(resolve));
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

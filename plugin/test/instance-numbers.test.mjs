import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { build } from "esbuild";

const extensionId = "a".repeat(32);
const { version } = JSON.parse(await readFile("plugin/version.json", "utf8"));
async function peer(port, name, sockets) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: `chrome-extension://${extensionId}` });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Display number registration timed out")), 5000);
    const finish = (error, result) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    socket.once("error", (error) => finish(error));
    socket.once("close", (code) => finish(new Error(`Peer closed: ${code}`)));
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          type: "modcdp.reverse.hello",
          version: 2,
          extension_id: extensionId,
          extension_version: version,
          ...(name === undefined ? {} : { name }),
        }),
      ),
    );
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      if (message.type === "snow.bridge.registered") finish(null, message);
    });
  });
}

test(
  "display numbers distinguish duplicate names, never reuse a disconnected number, and reset only with the broker",
  { timeout: 30000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-display-numbers-"));
    const bundled = path.resolve(".llmdoc-tmp/plugin-tests/broker-display-numbers.mjs");
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
    const sockets = [];
    let broker;
    try {
      broker = new BrowserBroker({ home: scratch, extensionId, bridgePort: 0 });
      await broker.init();
      const session = broker.createSession();
      const one = await peer(broker.bridge.port, "工作浏览器", sockets);
      const two = await peer(broker.bridge.port, "工作浏览器", sockets);
      const unnamed = await peer(broker.bridge.port, "   ", sockets);
      assert.equal(one.name, two.name);
      assert.deepEqual([one.display_number, two.display_number, unnamed.display_number], [1, 2, 3]);
      assert.equal(unnamed.name, "浏览器 3");
      assert.notEqual(one.instance_id, two.instance_id);
      const status = await broker.call(session, "browser_status", {});
      assert.equal(status.selected, null);
      assert.deepEqual(
        status.instances.map((i) => i.display_number),
        [1, 2, 3],
      );
      for (const instance of broker.instances.values()) {
        assert.equal(instance.browser, null, "registration and display numbering must not connect Playwright");
      }
      await assert.rejects(broker.call(session, "browser_select", { mode: "reuse", instance_id: "1" }));
      const closed = new Promise((resolve) => sockets[0].once("close", resolve));
      sockets[0].close();
      await closed;
      const four = await peer(broker.bridge.port, "工作浏览器", sockets);
      assert.equal(four.display_number, 4, "disconnect must not free a number for reuse");
      await assert.rejects(
        broker.call(session, "browser_select", { mode: "reuse", instance_id: one.instance_id }),
        /not connected/,
      );
      await broker.call(session, "browser_select", { mode: "reuse", instance_id: two.instance_id });
      assert.equal((await broker.call(session, "browser_status", {})).selected, two.instance_id);
      await broker.close();
      broker = new BrowserBroker({ home: scratch, extensionId, bridgePort: 0 });
      await broker.init();
      const restarted = await peer(broker.bridge.port, undefined, sockets);
      assert.equal(restarted.display_number, 1);
      assert.equal(restarted.name, "浏览器 1");
      assert.notEqual(restarted.instance_id, one.instance_id, "a reset display number is not a persistent identity");
      const nextSession = broker.createSession();
      assert.equal((await broker.call(nextSession, "browser_status", {})).selected, null);
      await assert.rejects(
        broker.call(nextSession, "browser_select", { mode: "reuse", instance_id: one.instance_id }),
        /not connected/,
      );
    } finally {
      for (const socket of sockets) socket.close();
      await broker?.close();
      assert.ok(path.resolve(scratch).startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

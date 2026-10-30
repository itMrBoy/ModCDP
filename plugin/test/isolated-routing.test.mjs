import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { build } from "esbuild";

const extensionId = "a".repeat(32);
const { version: extensionVersion } = JSON.parse(await readFile("plugin/version.json", "utf8"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error("Condition did not settle");
}
function peer(port, launch_token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: `chrome-extension://${extensionId}` });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No registration response")), 5000);
    socket.on("error", reject);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "modcdp.reverse.hello",
          version: 2,
          extension_version: extensionVersion,
          extension_id: extensionId,
          ...(launch_token ? { launch_token } : {}),
        }),
      ),
    );
    socket.on("message", (data) => {
      const value = JSON.parse(data);
      if (value.type === "snow.bridge.registered") {
        clearTimeout(timer);
        resolve(value);
      }
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Peer closed: ${code}`));
    });
  });
  return { socket, ready };
}

test(
  "isolated launch nonce matches only its own profile; reconnect never silently reselects and leaving requires confirmation",
  { timeout: 30000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "snow-nonce-fixture-"));
    const bundled = path.resolve(".llmdoc-tmp/plugin-tests/broker-nonce.mjs");
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
    let processOwnership = false;
    const broker = new BrowserBroker({
      home: scratch,
      extensionId,
      extensionVersion,
      bridgePort: 0,
      // Deliberately injected process fixture. This does not prove real Snow ownership.
      checkIsolated: async () => {
        if (processOwnership instanceof Error) throw processOwnership;
        return processOwnership;
      },
    });
    const sockets = [];
    try {
      await broker.init();
      const creator = broker.createSession(),
        other = broker.createSession();
      const record = {
        instance_id: randomUUID(),
        launch_token: "c".repeat(64),
        creator_session_id: creator,
        initialized: false,
        profile: path.join(scratch, "fake-owned-profile"),
        pid: null,
      };
      broker.records.push(record);
      Object.assign(broker.session(creator), { pending: record.instance_id, isolation: record.instance_id });
      const endpoint = `http://127.0.0.1:${broker.bridge.port}/initialize/${record.launch_token}`;
      assert.equal((await fetch(endpoint)).status, 200);
      const unmatched = peer(broker.bridge.port, "d".repeat(64));
      sockets.push(unmatched.socket);
      await assert.rejects(unmatched.ready, /1008/);
      const ordinary = peer(broker.bridge.port);
      sockets.push(ordinary.socket);
      const normal = await ordinary.ready;
      assert.equal(normal.owned, false);
      assert.equal(
        (await broker.call(creator, "browser_status", {})).selected,
        null,
        "a normal profile cannot satisfy a pending isolated launch",
      );
      assert.ok((await broker.call(creator, "browser_status", {})).pending_isolation);
      await assert.rejects(
        broker.call(creator, "browser_select", { mode: "reuse", instance_id: normal.instance_id }),
        /browser_finish/,
      );
      const exited = peer(broker.bridge.port, record.launch_token);
      sockets.push(exited.socket);
      await assert.rejects(exited.ready, /1008/);
      let failed = await broker.call(creator, "browser_status", {});
      assert.equal(failed.selected, null, "a matching token cannot substitute for process ownership");
      assert.equal(failed.pending_isolation.state, "launch_exited_unverified");
      assert.equal(failed.pending_isolation.launch_process_running, false);
      assert.equal(record.initialized, false);
      processOwnership = new Error("fixture ownership query failed");
      const unverified = peer(broker.bridge.port, record.launch_token);
      sockets.push(unverified.socket);
      await assert.rejects(unverified.ready, /1008/);
      failed = await broker.call(creator, "browser_status", {});
      assert.equal(failed.selected, null);
      assert.equal(failed.pending_isolation.state, "launch_exited_unverified");
      assert.equal(failed.pending_isolation.launch_process_running, false);
      await broker.call(other, "browser_select", { mode: "reuse", instance_id: normal.instance_id });
      assert.equal(
        (await broker.call(other, "browser_status", {})).selected,
        normal.instance_id,
        "failed ownership queries must not prevent selecting other ordinary profiles",
      );
      processOwnership = true;
      assert.equal((await broker.call(creator, "browser_status", {})).pending_isolation.state, "waiting_for_extension");
      const isolated = peer(broker.bridge.port, record.launch_token);
      sockets.push(isolated.socket);
      const first = await isolated.ready;
      assert.equal(first.owned, true);
      assert.equal((await broker.call(creator, "browser_status", {})).selected, first.instance_id);
      assert.equal((await fetch(endpoint)).status, 404, "initialization URL is consumed after matching registration");
      const duplicate = peer(broker.bridge.port, record.launch_token);
      sockets.push(duplicate.socket);
      await assert.rejects(duplicate.ready, /1008/);
      isolated.socket.close();
      await until(() => !broker.instances.has(first.instance_id));
      await assert.rejects(
        broker.call(creator, "browser_select", { mode: "reuse", instance_id: normal.instance_id }),
        /browser_finish/,
      );
      const reconnected = peer(broker.bridge.port, record.launch_token);
      sockets.push(reconnected.socket);
      const fresh = await reconnected.ready;
      assert.notEqual(fresh.instance_id, first.instance_id);
      assert.notEqual(
        (await broker.call(creator, "browser_status", {})).selected,
        fresh.instance_id,
        "old session must not be rebound",
      );
      await assert.rejects(broker.call(creator, "browser_finish", { close_and_cleanup: false }), /confirmed_by_user/);
      const preserved = await broker.call(creator, "browser_finish", {
        close_and_cleanup: false,
        confirmed_by_user: true,
      });
      assert.equal(preserved.browser_preserved, true);
      assert.ok(broker.records.includes(record));
      await broker.call(other, "browser_select", { mode: "reuse", instance_id: fresh.instance_id });
      await assert.rejects(
        broker.call(other, "browser_finish", { close_and_cleanup: true, confirmed_by_user: true }),
        /did not create/,
      );
      processOwnership = false;
      await assert.rejects(broker.call(other, "browser_tabs", {}), /no page operation|ownership/i);
      assert.equal(
        broker.instances.has(fresh.instance_id),
        false,
        "an extension that outlives its verified isolated process must be detached before page commands",
      );
      assert.equal(broker.instances.has(normal.instance_id), true, "ordinary instances must remain connected");
      processOwnership = true;
      await broker.call(other, "browser_finish", { close_and_cleanup: false, confirmed_by_user: true });
      await broker.call(creator, "browser_select", { mode: "reuse", instance_id: normal.instance_id });
      assert.equal((await broker.call(creator, "browser_status", {})).selected, normal.instance_id);
    } finally {
      for (const socket of sockets) socket.terminate();
      await broker.close();
      const resolved = path.resolve(scratch);
      assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(resolved, { recursive: true, force: true });
    }
  },
);

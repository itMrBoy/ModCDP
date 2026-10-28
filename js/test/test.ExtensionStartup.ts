// MODCDP_TS_ONLY_TEST: Real browser coverage of extension startup transport choices.
// NO MOCKING, NO MONKEY PATCHING, NO SIMULATING, NO FAKING, NO SKIPPING ALLOWED.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBinaryPath } from "@eplightning/nats-server";
import { test } from "vitest";
import { LocalBrowserLauncher, ModCDPClient } from "../src/index.js";
import { NATSUpstreamTransport } from "../src/transport/NATSUpstreamTransport.js";
import { WSUpstreamTransport } from "../src/transport/WSUpstreamTransport.js";
import * as Target from "../src/types/generated/zod/Target.js";
import { buildExtensionFixture } from "./helpers.extension.js";

test("default extension keeps optional connections disabled across tab creation and reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "modcdp-startup-"));
  const netlog = path.join(dir, "netlog.json");
  // Build defaults explicitly: dist/extension may hold an opt-in proxy build.
  const extension = await buildExtensionFixture({});
  const extension_path = extension.extension_path;
  const launcher = new LocalBrowserLauncher({
    launcher_local_headless: true,
    launcher_local_extra_args: [
      `--load-extension=${extension_path}`,
      `--log-net-log=${netlog}`,
      "--net-log-capture-mode=Everything",
    ],
  });
  let client: ModCDPClient | undefined;
  let control: WSUpstreamTransport | undefined;
  try {
    const browser = await launcher.launch();
    const connect = async () => {
      const cdp = new ModCDPClient({
        launcher: { launcher_mode: "remote", launcher_remote_cdp_url: browser.cdp_url! },
        upstream: { upstream_mode: "ws", upstream_ws_cdp_url: browser.cdp_url! },
        injector: {
          injector_mode: "discover",
          injector_discover_extension_path: extension_path,
          injector_trust_service_worker_target: true,
          injector_require_service_worker_target: true,
        },
      });
      try {
        await cdp.connect();
        return cdp;
      } catch (error) {
        await cdp.close();
        throw error;
      }
    };
    const assertTransports = async () => {
      assert.deepEqual(
        await client!.send("Mod.evaluate", { expression: "Object.keys(globalThis.ModCDP.downstream.status())" }),
        ["nativemessaging"],
      );
    };
    client = await connect();
    await assertTransports();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await client.send("Target.createTarget", { url: "about:blank#startup-regression" });
    await assertTransports();
    const extension_id = client.injector!.extension_id;
    await client.close();
    client = undefined;
    control = new WSUpstreamTransport({ upstream_ws_cdp_url: browser.cdp_url! });
    await control.connect();
    const { targetId } = await control.send(Target.CreateTargetCommand, { url: "chrome://extensions" });
    const { sessionId } = await control.send(Target.AttachToTargetCommand, { targetId, flatten: true });
    const deadline = Date.now() + 10_000;
    while (true) {
      const ready = await control.send(
        "Runtime.evaluate",
        { expression: "typeof chrome.developerPrivate?.reload === 'function'", returnByValue: true },
        sessionId,
      );
      if ((ready.result as { value?: boolean }).value) break;
      assert.ok(Date.now() < deadline, "Extensions page did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Command-line-loaded extensions still need Developer mode for a UI reload.
    const reload = await control.send(
      "Runtime.evaluate",
      {
        expression: `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}); new Promise((resolve,reject)=>chrome.developerPrivate.reload(${JSON.stringify(extension_id)},{failQuietly:true},()=>{const error=chrome.runtime.lastError; error?reject(new Error(error.message)):resolve(true)}))`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    assert.equal(reload.exceptionDetails, undefined, JSON.stringify(reload));
    assert.equal((reload.result as { value?: boolean }).value, true);
    client = await connect();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await assertTransports();
    assert.equal(await client.send("Mod.evaluate", { expression: "1 + 1" }), 2);
    await client.close();
    client = undefined;
    const browser_exit = once(browser.proc as ChildProcess, "exit");
    await control.send("Browser.close");
    await browser_exit;
    await control.close();
    await launcher.close();
    const network = JSON.parse(await readFile(netlog, "utf8"));
    assert.doesNotMatch(JSON.stringify(network.events), /wss?:\/\/127\.0\.0\.1:(29292|4223)\b/);
  } finally {
    await client?.close();
    await control?.close();
    await launcher.close();
    await extension.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("explicitly enabled NATS extension serves commands through a real NATS server", async () => {
  const extension = await buildExtensionFixture({ enable_nats: true });
  const dir = await mkdtemp(path.join(tmpdir(), "modcdp-startup-nats-"));
  const config_path = path.join(dir, "nats.conf");
  const websocket_port = await LocalBrowserLauncher.freePort();
  const subject = `modcdp.startup.${Date.now()}`;
  const url = `ws://127.0.0.1:${websocket_port}`;
  await writeFile(
    config_path,
    `host: "127.0.0.1"\nport: ${await LocalBrowserLauncher.freePort()}\nwebsocket { host: "127.0.0.1", port: ${websocket_port}, no_tls: true }\n`,
  );
  const server = spawn(await getBinaryPath(), ["-c", config_path], { stdio: "ignore", windowsHide: true });
  const owner = new ModCDPClient({
    launcher: { launcher_mode: "local", launcher_local_headless: true },
    upstream: { upstream_mode: "ws" },
    injector: { injector_mode: "cli", injector_cli_extension_path: extension.extension_path },
  });
  const transport = new NATSUpstreamTransport({
    upstream_nats_url: url,
    upstream_nats_subject_prefix: subject,
    upstream_nats_wait_timeout_ms: 10_000,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      assert.equal(server.exitCode, null, "NATS server exited during startup");
      try {
        await transport.connect();
        break;
      } catch (error) {
        await transport.close();
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await owner.connect();
    // Use the real transport lifecycle with an isolated broker/subject so an
    // already installed extension cannot answer this browser's test requests.
    await owner.send("Mod.evaluate", {
      expression: `(() => { const transport = globalThis.ModCDP.downstream.transports.get('nats'); transport.stop(); return transport.start(${JSON.stringify(url)}, {upstream_nats_subject_prefix:${JSON.stringify(subject)}}); })()`,
    });
    await transport.waitForPeer();
    assert.equal(await transport.send("Mod.evaluate", { expression: "1 + 1" }), 2);
    assert.deepEqual(
      await transport.send("Mod.evaluate", { expression: "Object.keys(globalThis.ModCDP.downstream.status())" }),
      ["nativemessaging", "nats"],
    );
  } finally {
    await transport.close();
    await owner.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    await extension.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

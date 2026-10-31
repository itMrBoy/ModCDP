import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, open, unlink, appendFile, realpath } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserBroker } from "./broker.mjs";
import { assertBrowserLifetimePreserved } from "./isolated.mjs";

const runFile = promisify(execFile);
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const version = (runtime) => {
  const match = /^(\d+)\.(\d+)\.(\d+):[a-f0-9]{64}$/.exec(runtime ?? "");
  if (!match) throw new Error("Invalid cdpHelper plugin runtime identity.");
  return match.slice(1).map(Number);
};
export function compareRuntimeVersions(left, right) {
  const a = version(left),
    b = version(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function failure(code, message, snapshot) {
  const error = new Error(message);
  error.code = code;
  if (snapshot) {
    error.snapshot = snapshot;
    error.backend_runtime = snapshot.runtime;
  }
  return error;
}
export async function rpc(meta, operation, payload = {}, timeout = 45000) {
  if (!Number.isInteger(meta.port) || meta.port < 1 || meta.port > 65535)
    throw new Error("Invalid daemon metadata port.");
  const response = await fetch(`http://127.0.0.1:${meta.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${meta.token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation, ...payload }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  if (!response.ok) throw failure(body.code ?? "PLUGIN_SERVICE_ERROR", body.error ?? `Daemon HTTP ${response.status}`);
  return body;
}
export async function inspectDaemon({ home }) {
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const status = await rpc(meta, "status", {}, 2000);
    if (status.pid !== meta.pid || status.runtime !== meta.runtime)
      throw new Error("cdpHelper plugin daemon identity differs from its metadata.");
    return { meta, status };
  } catch (error) {
    if (alive(meta.pid))
      throw failure(
        "PLUGIN_SERVICE_UNVERIFIED",
        `Cannot verify cdpHelper plugin backend: ${error.message}. No process was terminated.`,
      );
    return null;
  }
}
export async function runDaemon({ home, runtime, entry, extensionId, extensionVersion, bridgePort, releaseUrl }) {
  const broker = new BrowserBroker({ home, extensionId, extensionVersion, bridgePort, releaseUrl });
  await broker.init();
  const token = randomBytes(32).toString("hex");
  const generation = randomBytes(16).toString("hex");
  let lastClient = Date.now(),
    closing = false,
    retiring = false;
  const metaFile = path.join(home, "daemon.json");
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      req.url !== "/rpc" ||
      req.method !== "POST" ||
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers.origin
    ) {
      send(403, { error: "Unauthorized local RPC" });
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 200000) throw new Error("RPC request too large");
      }
      const { operation, session_id, name, args, expected_runtime, target_runtime } = JSON.parse(raw);
      if (operation === "status") {
        send(200, {
          runtime,
          sessions: broker.sessions.size,
          pid: process.pid,
          closing: closing || retiring,
          service_protocol: 1,
          generation,
          extension_version: extensionVersion,
          rejected_extensions: broker.rejectedExtensions ?? [],
        });
        return;
      }
      if (operation === "retire" || operation === "upgrade") {
        if (retiring || closing) throw new Error("cdpHelper plugin backend is already changing generations.");
        if (expected_runtime !== runtime || compareRuntimeVersions(target_runtime, runtime) <= 0)
          throw failure(
            "PLUGIN_RELOAD_REQUIRED",
            "An old cdpHelper plugin cannot retire or downgrade this backend. Reload the cdpHelper plugin configuration in this host.",
          );
        if (operation === "retire" && broker.sessions.size)
          throw new Error("cdpHelper plugin backend still has active sessions.");
        retiring = true;
        send(200, { retiring: true, generation, interrupted_sessions: broker.sessions.size });
        setImmediate(() => void shutdown(true));
        return;
      }
      if (closing || retiring)
        throw failure(
          "PLUGIN_RELOAD_REQUIRED",
          "cdpHelper plugin backend changed. Reload the host's cdpHelper plugin configuration; Snow Browser does not need restarting.",
        );
      lastClient = Date.now();
      if (operation === "open") send(200, { session_id: broker.createSession(), generation });
      else if (operation === "heartbeat") {
        broker.heartbeat(session_id);
        send(200, { alive: true });
      } else if (operation === "drop") {
        await broker.dropSession(session_id);
        send(200, { released: true });
      } else if (operation === "tool") {
        const result = await broker.call(session_id, name, args);
        if (retiring || closing)
          throw failure(
            "PLUGIN_RELOAD_REQUIRED",
            "The old cdpHelper plugin operation was interrupted by backend upgrade. Already issued page effects may continue; do not replay the operation.",
          );
        send(200, result);
      } else throw new Error("Unknown RPC operation");
    } catch (error) {
      send(400, { error: error.message, code: error.code });
    }
  });
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const meta = { token, runtime, pid: process.pid, port: server.address().port, entry, service_protocol: 1 };
  await writeFile(`${metaFile}.tmp`, JSON.stringify(meta), { mode: 0o600 });
  await renameFile(`${metaFile}.tmp`, metaFile);
  const timer = setInterval(() => {
    for (const [id, session] of broker.sessions)
      if (!session.active && Date.now() - session.lastSeen > 20000) void broker.dropSession(id);
    if (broker.sessions.size) lastClient = Date.now();
    else if (Date.now() - lastClient > 30000) void shutdown();
  }, 5000);
  async function shutdown(bounded = false) {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    // This watchdog terminates only this plugin daemon, never a host or browser.
    const watchdog = bounded ? setTimeout(() => process.exit(0), 10000) : null;
    try {
      await broker.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const current = JSON.parse(await readFile(metaFile, "utf8"));
      if (current.token === token) await unlink(metaFile);
    } catch (error) {
      console.error(`cdpHelper plugin shutdown: ${error.message}`);
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
        process.exit(0);
      }
    }
  }
  process.once("SIGTERM", () => void shutdown(true));
  process.once("SIGINT", () => void shutdown(true));
}
async function renameFile(from, to) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

// Signals are permitted only after verifying the owned daemon's complete argv and build.
export async function verifyDaemonProcess(meta, home) {
  if (process.platform !== "win32")
    throw new Error(
      "Cannot verify legacy cdpHelper plugin process ownership on this platform. Reload the old host's cdpHelper plugin manually.",
    );
  if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0) throw new Error("Invalid cdpHelper plugin process identity.");
  const runtimeRoot = await realpath(path.join(home, "runtimes"));
  const entry = await realpath(meta.entry);
  const relative = path.relative(runtimeRoot, entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(entry) !== "cli.mjs")
    throw new Error("cdpHelper plugin daemon entry is outside the owned runtime directory.");
  const build = JSON.parse(await readFile(path.join(path.dirname(entry), "build.json"), "utf8"));
  if (`${build.version}:${build.digest}` !== meta.runtime)
    throw new Error("cdpHelper plugin daemon build identity mismatch.");
  const { stdout } = await runFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${meta.pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 15000 },
  );
  const processInfo = JSON.parse(stdout);
  const executable = await realpath(process.execPath);
  const actualExecutable = processInfo?.ExecutablePath ? await realpath(processInfo.ExecutablePath) : null;
  if (!actualExecutable || actualExecutable.toLowerCase() !== executable.toLowerCase())
    throw new Error("cdpHelper plugin daemon executable mismatch.");
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const argument = (value) => `(?:"${escape(value)}"|${escape(value)})`;
  const pattern = new RegExp(
    `^(?:${argument(executable)}|${argument(processInfo.ExecutablePath)}|${argument(process.execPath)})\\s+${argument(entry)}\\s+--daemon\\s+--home\\s+${argument(path.resolve(home))}\\s+--bridge-port\\s+\\d+$`,
    "i",
  );
  if (!pattern.test(processInfo.CommandLine))
    throw new Error("cdpHelper plugin daemon arguments do not match its owned entry and home.");
  return true;
}

async function signalOwnedDaemon(meta, home, signal) {
  try {
    await verifyDaemonProcess(meta, home);
    process.kill(meta.pid, signal);
  } catch (error) {
    // The cooperative watchdog may finish between the liveness check and CIM.
    if (alive(meta.pid)) throw error;
  }
}

export async function ensureDaemon(config, { upgradeFrom } = {}) {
  const { home, runtime, entry, bridgePort } = config;
  version(runtime);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockFile = path.join(home, "startup.lock");
  const metaFile = path.join(home, "daemon.json");
  const floorFile = path.join(home, "runtime-floor.json");
  const rememberRuntime = async () => {
    await writeFile(`${floorFile}.tmp`, JSON.stringify({ runtime }), { mode: 0o600 });
    await renameFile(`${floorFile}.tmp`, floorFile);
  };
  for (let attempt = 0; attempt < 150; attempt++) {
    let lock;
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockFile, "utf8"));
        if (!alive(owner.pid)) await unlink(lockFile);
      } catch (readError) {
        if (readError.code !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
      }
      await delay(200);
      continue;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      try {
        const floor = JSON.parse(await readFile(floorFile, "utf8"));
        if (compareRuntimeVersions(runtime, floor.runtime) === 0 && runtime !== floor.runtime)
          throw failure(
            "PLUGIN_RUNTIME_CONFLICT",
            "The installed cdpHelper plugin has a different digest for an already activated release version. Reinstall the official cdpHelper plugin; no backend was replaced.",
            { runtime: floor.runtime },
          );
        if (compareRuntimeVersions(runtime, floor.runtime) < 0)
          throw failure(
            "PLUGIN_RELOAD_REQUIRED",
            `This host still loads cdpHelper plugin ${runtime.split(":")[0]}; plugin ${floor.runtime.split(":")[0]} has already been activated. Reload this host's cdpHelper plugin configuration, not Snow Browser.`,
            { runtime: floor.runtime },
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const inspected = await inspectDaemon(config);
      if (inspected) {
        const { meta, status } = inspected;
        if (status.closing) {
          await delay(200);
          continue;
        }
        if (status.runtime === runtime) {
          await rememberRuntime();
          return meta;
        }
        const comparison = compareRuntimeVersions(runtime, status.runtime);
        if (comparison <= 0)
          throw failure(
            comparison < 0 ? "PLUGIN_RELOAD_REQUIRED" : "PLUGIN_RUNTIME_CONFLICT",
            `This host's cdpHelper plugin (${runtime.split(":")[0]}) cannot replace backend ${status.runtime.split(":")[0]}. Reload this host's cdpHelper plugin configuration; do not restart Snow Browser.`,
            { runtime: status.runtime },
          );
        const snapshot = { runtime: meta.runtime, pid: meta.pid, token: meta.token };
        if (!upgradeFrom || Object.entries(snapshot).some(([key, value]) => upgradeFrom[key] !== value))
          throw failure(
            "PLUGIN_UPGRADE_REQUIRED",
            "Notify the user before interrupting the old cdpHelper plugin backend.",
            snapshot,
          );
        try {
          await assertBrowserLifetimePreserved(home);
        } catch (error) {
          throw failure(
            "PLUGIN_BROWSER_PRESERVATION_BLOCKED",
            `cdpHelper plugin 后台从 ${meta.runtime.split(":")[0]} 升级至 ${runtime.split(":")[0]} 已阻止：${error.message} 为保留雪诺窗口、标签页和 profile，旧 plugin 后台保持运行。待你主动结束这些旧隔离窗口后，再升级 cdpHelper plugin；不会自动关闭窗口。`,
            snapshot,
          );
        }
        if (status.service_protocol === 1)
          await rpc(meta, "upgrade", { expected_runtime: meta.runtime, target_runtime: runtime });
        else {
          await signalOwnedDaemon(meta, home, "SIGTERM");
        }
        // The cooperative daemon starts its ten-second watchdog after the RPC
        // acknowledgement. Allow scheduling/exit observation time before any
        // separately ownership-verified signal fallback.
        const deadline = Date.now() + (status.service_protocol === 1 ? 12000 : 10000);
        while (alive(meta.pid) && Date.now() < deadline) await delay(100);
        if (alive(meta.pid)) {
          await signalOwnedDaemon(meta, home, "SIGKILL");
        }
        for (let i = 0; i < 30 && alive(meta.pid); i++) await delay(100);
        if (alive(meta.pid))
          throw new Error("Old cdpHelper plugin backend did not stop; no other process was terminated.");
      }
      const logHandle = await open(path.join(home, "daemon.log"), "a", 0o600);
      const child = spawn(process.execPath, [entry, "--daemon", "--home", home, "--bridge-port", String(bridgePort)], {
        detached: true,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
        windowsHide: true,
      });
      child.on("error", (error) => void appendFile(path.join(home, "daemon.log"), `${error.message}\n`));
      child.unref();
      await logHandle.close();
      for (let wait = 0; wait < 100; wait++) {
        if (child.exitCode !== null)
          throw new Error(
            `cdpHelper plugin backend exited during startup (${child.exitCode}); see ${path.join(home, "daemon.log")}`,
          );
        try {
          const candidate = JSON.parse(await readFile(metaFile, "utf8"));
          if (candidate.pid === child.pid && (await rpc(candidate, "status", {}, 1000)).runtime === runtime) {
            await rememberRuntime();
            return candidate;
          }
        } catch {}
        await delay(200);
      }
      throw new Error(`cdpHelper plugin backend startup timed out; see ${path.join(home, "daemon.log")}`);
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => {});
    }
  }
  throw new Error("Another client is starting the cdpHelper plugin backend; retry shortly.");
}

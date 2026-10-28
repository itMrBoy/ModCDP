import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, open, unlink, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserBroker } from "./broker.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
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
  if (!response.ok) throw new Error(body.error ?? `Daemon HTTP ${response.status}`);
  return body;
}

export async function runDaemon({ home, runtime, entry, extensionId, extensionVersion, bridgePort, releaseUrl }) {
  const broker = new BrowserBroker({ home, extensionId, extensionVersion, bridgePort, releaseUrl });
  await broker.init();
  const token = randomBytes(32).toString("hex");
  let lastClient = Date.now();
  let closing = false;
  let retiring = false;
  const metaFile = path.join(home, "daemon.json");
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
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
      const { operation, session_id, name, args } = JSON.parse(raw);
      if (operation === "status") {
        send(200, { runtime, sessions: broker.sessions.size, pid: process.pid, closing: closing || retiring });
        return;
      }
      if (operation === "retire") {
        if (broker.sessions.size)
          throw new Error(
            "The old runtime still has active sessions. End/reload those sessions to apply the upgraded plugin.",
          );
        retiring = true;
        send(200, { retiring: true });
        setImmediate(() => void shutdown());
        return;
      }
      if (closing || retiring) throw new Error("Daemon is shutting down; reconnect with a new session.");
      lastClient = Date.now();
      if (operation === "open") send(200, { session_id: broker.createSession() });
      else if (operation === "heartbeat") {
        broker.heartbeat(session_id);
        send(200, { alive: true });
      } else if (operation === "drop") {
        await broker.dropSession(session_id);
        send(200, { released: true });
      } else if (operation === "tool") send(200, await broker.call(session_id, name, args));
      else throw new Error("Unknown RPC operation");
    } catch (error) {
      send(400, { error: error.message });
    }
  });
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const meta = { token, runtime, pid: process.pid, port: server.address().port, entry };
  await writeFile(`${metaFile}.tmp`, JSON.stringify(meta), { mode: 0o600 });
  await renameFile(`${metaFile}.tmp`, metaFile);
  const timer = setInterval(() => {
    for (const [id, session] of broker.sessions) {
      if (!session.active && Date.now() - session.lastSeen > 20000) void broker.dropSession(id);
    }
    if (broker.sessions.size) lastClient = Date.now();
    else if (Date.now() - lastClient > 30000) void shutdown();
  }, 5000);
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await broker.close();
    await new Promise((resolve) => server.close(resolve));
    try {
      const current = JSON.parse(await readFile(metaFile, "utf8"));
      if (current.token === token) await unlink(metaFile);
    } catch {}
  }
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

async function renameFile(from, to) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

export async function ensureDaemon({ home, runtime, entry, bridgePort }) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockFile = path.join(home, "startup.lock");
  const metaFile = path.join(home, "daemon.json");
  for (let attempt = 0; attempt < 150; attempt++) {
    let meta;
    try {
      meta = JSON.parse(await readFile(metaFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (meta) {
      try {
        const status = await rpc(meta, "status", {}, 2000);
        if (status.closing) {
          await delay(200);
          continue;
        }
        if (status.runtime === runtime) return meta;
        if (status.sessions)
          throw new Error(
            "Plugin upgraded, but an older runtime still has active sessions. End/reload those sessions before using the new runtime.",
          );
        await rpc(meta, "retire");
        await delay(200);
        continue;
      } catch (error) {
        if (alive(meta.pid))
          throw new Error(`Cannot reuse the local Snow runtime: ${error.message}. No process was terminated.`);
      }
    }
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
      // Another adapter may have completed startup just before this lock was acquired.
      try {
        const candidate = JSON.parse(await readFile(metaFile, "utf8"));
        const status = await rpc(candidate, "status", {}, 1000);
        if (status.runtime === runtime && !status.closing) return candidate;
      } catch {}
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
            `Local runtime exited during startup (${child.exitCode}); see ${path.join(home, "daemon.log")}`,
          );
        try {
          const candidate = JSON.parse(await readFile(metaFile, "utf8"));
          if (candidate.pid === child.pid && (await rpc(candidate, "status", {}, 1000)).runtime === runtime)
            return candidate;
        } catch {}
        await delay(200);
      }
      throw new Error(`Local runtime startup timed out; see ${path.join(home, "daemon.log")}`);
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => {});
    }
  }
  throw new Error("Another client is starting the Snow runtime; retry shortly.");
}

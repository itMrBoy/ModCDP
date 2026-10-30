import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// One public extension entry point. Each accepted peer is relayed to its own
// authenticated ModCDP proxy; CDP sessions never cross browser connections.
export async function startBridge({ port, extensionId, extensionVersion, register, disconnected, initialization }) {
  const rejected = new Map();
  const bounded = (value) => (typeof value === "string" && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value) ? value : null);
  const rejectRegistration = (peer, reason, hello, message) => {
    const actualVersion = bounded(hello.extension_version);
    const actualParts = actualVersion?.split(".").map(Number);
    const expectedParts = extensionVersion.split(".").map(Number);
    const versionOrder =
      actualParts &&
      Array.from({ length: 4 }, (_, index) => (actualParts[index] ?? 0) - (expectedParts[index] ?? 0)).find(
        (value) => value !== 0,
      );
    const pluginUpdate = reason === "extension_update_required" && versionOrder > 0;
    const issue = {
      type: "modcdp.reverse.registration_error",
      reason,
      component: pluginUpdate ? "cdpHelper plugin" : "cdpHelper 浏览器扩展",
      required_action: pluginUpdate
        ? "plugin_update_or_reload"
        : reason === "extension_update_required"
          ? "extension_update"
          : reason === "identity_mismatch"
            ? "extension_reinstall"
            : "plugin_and_extension_update",
      plugin_version: extensionVersion,
      required_plugin_version: pluginUpdate ? actualVersion : extensionVersion,
      actual_extension_version: actualVersion,
      required_extension_version: extensionVersion,
      actual_protocol_version: Number.isSafeInteger(hello.version) ? hello.version : null,
      required_protocol_version: 2,
      message: pluginUpdate
        ? `当前雪诺 profile 中的 cdpHelper 浏览器扩展为 ${actualVersion}，本机 cdpHelper plugin 后台仍为 ${extensionVersion}，版本不配套。请将当前宿主（Codex 或 Claude Code）的 cdpHelper plugin 更新为与浏览器扩展 ${actualVersion} 配套的版本，并重新加载该宿主的插件配置；若不支持重新加载，请退出并重新打开该宿主。仅重连 MCP 可能继续使用旧启动路径，无需重启雪诺。`
        : message,
    };
    const key = JSON.stringify([reason, issue.actual_extension_version, issue.actual_protocol_version]);
    rejected.delete(key);
    rejected.set(key, { ...issue, last_seen: Date.now() });
    while (rejected.size > 20) rejected.delete(rejected.keys().next().value);
    peer.send(JSON.stringify(issue));
    peer.close(1008, reason);
  };
  const server = http.createServer((req, res) => {
    const token = /^\/initialize\/([a-f0-9]{64})$/.exec(req.url ?? "")?.[1];
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || !token || !initialization(token)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'",
    });
    res.end(
      "<!doctype html><title>cdpHelper connection</title><h1>cdpHelper</h1><p>Enable the cdpHelper bridge extension in this window. Keep this tab open until the instance appears in browser_status.</p>",
    );
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/bridge" ||
      req.headers.host !== `127.0.0.1:${server.address().port}` ||
      req.headers.origin !== `chrome-extension://${extensionId}`
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (peer) => wss.emit("connection", peer));
  });
  const tasks = new Set();
  wss.on("connection", (peer) => {
    let upstream;
    let instance;
    let stage = "hello";
    let buffered = [];
    let size = 0;
    const timer = setTimeout(() => peer.close(1008, "Hello timeout"), 5000);
    const relay = (data) => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data.toString());
    };
    peer.on("error", () => peer.close());
    peer.on("close", () => {
      clearTimeout(timer);
      stage = "closed";
      buffered = [];
      upstream?.close();
      if (instance) void disconnected(instance);
    });
    peer.on("message", (data, binary) => {
      if (stage === "closed") return;
      if (stage === "ready") {
        relay(data);
        return;
      }
      if (stage === "starting") {
        size += data.length;
        if (size > 1024 * 1024) peer.close(1009, "Pending connection overflow");
        else buffered.push(data);
        return;
      }
      stage = "starting";
      const task = (async () => {
        if (binary || data.length > 8192) throw new Error("Invalid hello");
        const hello = JSON.parse(data.toString());
        if (hello.type !== "modcdp.reverse.hello") throw new Error("Invalid hello type");
        if (hello.extension_id !== extensionId) {
          rejectRegistration(
            peer,
            "identity_mismatch",
            hello,
            "cdpHelper 浏览器扩展身份与本机 cdpHelper plugin 不匹配；请在目标 profile 手动加载正式 Release 的配套扩展。",
          );
          return;
        }
        if (hello.version !== 2) {
          rejectRegistration(
            peer,
            "protocol_mismatch",
            hello,
            `cdpHelper 浏览器扩展的桥接协议为 ${Number.isSafeInteger(hello.version) ? hello.version : "未知"}，本机 cdpHelper plugin ${extensionVersion} 要求协议 2。请更新配套的 cdpHelper 浏览器扩展和 plugin。`,
          );
          return;
        }
        if (hello.extension_version !== extensionVersion) {
          rejectRegistration(
            peer,
            "extension_update_required",
            hello,
            `当前雪诺 profile 中的 cdpHelper 浏览器扩展为 ${bounded(hello.extension_version) ?? "未知"}，本机 cdpHelper plugin ${extensionVersion} 要求扩展版本 ${extensionVersion}。请下载配套扩展 Release，替换文件后在该 profile 的扩展管理页手动重载 cdpHelper 浏览器扩展；若已更新扩展，请检查当前宿主的 cdpHelper plugin 及本机后台版本。`,
          );
          return;
        }
        if (
          (hello.name !== undefined && (typeof hello.name !== "string" || hello.name.length > 100)) ||
          (hello.launch_token !== undefined && !/^[a-f0-9]{64}$/.test(hello.launch_token))
        )
          throw new Error("Invalid extension registration metadata");
        instance = await register(hello, peer);
        if (stage === "closed") {
          await disconnected(instance);
          return;
        }
        upstream = new WebSocket(instance.endpoint);
        upstream.on("error", () => peer.close(1011, "Local proxy disconnected"));
        upstream.on("close", () => peer.close(1011, "Local proxy disconnected"));
        upstream.on("message", (message) => {
          if (peer.readyState === WebSocket.OPEN) peer.send(message.toString());
        });
        await new Promise((resolve, reject) => {
          upstream.once("open", resolve);
          upstream.once("error", reject);
          upstream.once("close", () => reject(new Error("Local proxy closed")));
        });
        if (stage === "closed") {
          upstream.close();
          return;
        }
        upstream.send(data.toString());
        peer.send(JSON.stringify(instance.registration));
        stage = "ready";
        clearTimeout(timer);
        for (const message of buffered) relay(message);
        buffered = [];
      })().catch((error) => {
        console.error(`cdpHelper bridge: ${error.message}`);
        peer.close(1008, "Extension registration failed; check protocol and local service logs");
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    wss.close();
    throw new Error(
      `Cannot listen on cdpHelper bridge port ${port}: ${error.message}. No existing process was terminated.`,
    );
  }
  return {
    port: server.address().port,
    get rejections() {
      return [...rejected.values()].filter((issue) => Date.now() - issue.last_seen < 15000);
    },
    async close() {
      for (const peer of wss.clients) peer.terminate();
      await Promise.allSettled([...tasks]);
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => {
        server.close(resolve);
        // An open initialization tab can retain an incomplete HTTP connection.
        // Stop accepting first, then release only this service's HTTP connections.
        server.closeAllConnections();
      });
    },
  };
}

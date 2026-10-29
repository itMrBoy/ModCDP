import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// One public extension entry point. Each accepted peer is relayed to its own
// authenticated ModCDP proxy; CDP sessions never cross browser connections.
export async function startBridge({ port, extensionId, extensionVersion, register, disconnected, initialization }) {
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
        if (
          hello.type !== "modcdp.reverse.hello" ||
          hello.version !== 2 ||
          hello.extension_id !== extensionId ||
          hello.extension_version !== extensionVersion ||
          (hello.name !== undefined && (typeof hello.name !== "string" || hello.name.length > 100)) ||
          (hello.launch_token !== undefined && !/^[a-f0-9]{64}$/.test(hello.launch_token))
        )
          throw new Error("Incompatible extension identity or bridge protocol; install the matching cdpHelper Release");
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
    async close() {
      for (const peer of wss.clients) peer.terminate();
      await Promise.allSettled([...tasks]);
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

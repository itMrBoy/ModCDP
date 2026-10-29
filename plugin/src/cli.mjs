import path from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { tools, parseTool } from "./tools.mjs";
import { ensureDaemon, runDaemon, rpc } from "./service.mjs";

async function main() {
  const entry = fileURLToPath(import.meta.url);
  const root = path.dirname(entry);
  const build = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
  const homeArg = process.argv.indexOf("--home");
  const home = path.resolve(homeArg >= 0 ? process.argv[homeArg + 1] : path.join(homedir(), ".cdphelper"));
  const portArg = process.argv.indexOf("--bridge-port");
  const bridgePort = portArg >= 0 ? Number(process.argv[portArg + 1]) : build.bridge_port;
  if (!Number.isInteger(bridgePort) || bridgePort < 0 || bridgePort > 65535) throw new Error("Invalid bridge port");
  const config = {
    home,
    entry,
    runtime: `${build.version}:${build.digest}`,
    extensionId: build.expected_extension_id,
    extensionVersion: build.extension_version,
    bridgePort,
    releaseUrl: build.release_url,
  };
  if (process.argv.includes("--daemon")) {
    await runDaemon(config);
    return;
  }
  const meta = await ensureDaemon(config);
  const { session_id } = await rpc(meta, "open");
  const server = new Server({ name: "cdphelper", version: build.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", ...z.toJSONSchema(t.schema) },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      parseTool(request.params.name, request.params.arguments);
      const result = await rpc(
        meta,
        "tool",
        { session_id, name: request.params.name, args: request.params.arguments },
        60000,
      );
      return {
        content: result.image
          ? [{ type: "image", data: result.image, mimeType: "image/png" }]
          : [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
  const timer = setInterval(
    () => void rpc(meta, "heartbeat", { session_id }, 5000).catch((error) => console.error(error.message)),
    5000,
  );
  timer.unref();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await rpc(meta, "drop", { session_id }, 5000).catch(() => {});
  };
  server.onclose = () => {
    void stop();
  };
  const shutdown = () => {
    void stop()
      .then(() => server.close())
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  };
  process.stdin.once("end", () => {
    shutdown();
  });
  process.once("SIGINT", () => {
    shutdown();
  });
  process.once("SIGTERM", () => {
    shutdown();
  });
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error(`cdpHelper: ${error.message}`);
  process.exitCode = 1;
});

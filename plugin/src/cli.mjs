import path from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { tools, parseTool } from "./tools.mjs";
import { ensureDaemon, inspectDaemon, runDaemon, rpc } from "./service.mjs";
import { RuntimeClient } from "./runtime-client.mjs";

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
  const runtimeClient = new RuntimeClient(config, { ensureDaemon, inspectDaemon, rpc });
  const server = new Server({ name: "cdphelper", version: build.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", ...z.toJSONSchema(t.listingSchema ?? t.schema) },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      parseTool(request.params.name, request.params.arguments);
      runtimeClient.setHost(server.getClientVersion()?.name);
      const result = await runtimeClient.call(request.params.name, request.params.arguments ?? {});
      return {
        content: result.image
          ? [{ type: "image", data: result.image, mimeType: "image/png" }]
          : [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
  const timer = setInterval(() => void runtimeClient.heartbeat(), 5000);
  timer.unref();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await runtimeClient.close();
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";

const source = path.resolve("dist/plugin-marketplace/plugins/cdphelper");
async function client(plugin, home, bridgePort = "0") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(plugin, "launch.mjs"), "--home", home, "--bridge-port", bridgePort],
    stderr: "pipe",
    env: { ...process.env, NODE_PATH: "" },
  });
  let errors = "";
  transport.stderr?.on("data", (data) => {
    errors += data;
  });
  const connection = new Client({ name: "cdphelper-plugin-verification", version: "1.0.0" });
  try {
    await connection.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`${error.message}: ${errors}`);
  }
  return connection;
}
async function status(connection) {
  const result = await connection.callTool({ name: "browser_status", arguments: {} });
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}
async function retire(home) {
  try {
    const meta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
    await fetch(`http://127.0.0.1:${meta.port}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${meta.token}` },
      body: JSON.stringify({
        operation: "retire",
        expected_runtime: meta.runtime,
        target_runtime: "99.0.0:test-cleanup",
      }),
    });
  } catch {}
}

test(
  "MCP tool discovery survives an unavailable bridge; status reports failure without an empty inventory",
  { timeout: 60000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-unavailable-"));
    const occupied = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    let connection;
    try {
      connection = await client(source, scratch, String(occupied.address().port));
      assert.equal((await connection.listTools()).tools.length, 26);
      const result = await status(connection);
      assert.equal(result.runtime.state, "failed");
      assert.equal(result.instances, null);
      assert.match(result.runtime.message, /cdpHelper plugin/);
      assert.ok(occupied.listening, "an unknown listener is never stopped");
    } finally {
      await connection?.close();
      await new Promise((resolve) => occupied.close(resolve));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "portable packaged runtime starts offline without the development tree; two MCP clients share one authenticated daemon",
  { timeout: 60000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-plugin-test-"));
    const plugin = path.join(scratch, "plugin");
    const home = path.join(scratch, "home");
    let a, b;
    try {
      await cp(source, plugin, { recursive: true });
      const check = JSON.parse(
        execFileSync(process.execPath, [path.join(plugin, "launch.mjs"), "--check"], { encoding: "utf8" }),
      );
      assert.equal(check.valid, true);
      [a, b] = await Promise.all([client(plugin, home), client(plugin, home)]);
      const definitions = await a.listTools();
      assert.ok(definitions.tools.some((t) => t.name === "browser_select"));
      for (const tool of definitions.tools) {
        assert.equal(tool.inputSchema.type, "object", tool.name);
        for (const keyword of ["oneOf", "anyOf", "allOf"]) {
          assert.ok(!(keyword in tool.inputSchema), `${tool.name} has root-level ${keyword}`);
        }
      }
      const selectionSchema = definitions.tools.find((t) => t.name === "browser_select").inputSchema;
      assert.deepEqual(selectionSchema.properties.mode.enum, ["reuse", "isolated"]);
      assert.deepEqual(selectionSchema.required, ["mode"]);
      assert.equal(selectionSchema.properties.instance_id.type, "string");
      assert.equal(selectionSchema.properties.executable.type, "string");
      assert.equal(selectionSchema.additionalProperties, false);
      assert.ok(!definitions.tools.some((t) => /run_code/.test(t.name)));
      const evaluate = definitions.tools.find((t) => t.name === "browser_evaluate");
      assert.ok(evaluate);
      assert.equal(evaluate.annotations.readOnlyHint, false);
      assert.equal(evaluate.annotations.destructiveHint, true);
      assert.ok(!definitions.tools.some((t) => /configure_extension/.test(t.name)));
      assert.equal((await status(a)).selection_required, true);
      assert.equal((await status(b)).selection_required, true);
      const forbidden = await a.callTool({ name: "browser_tabs", arguments: {} });
      assert.equal(forbidden.isError, true);
      assert.match(forbidden.content[0].text, /select|choose/i);
      const forged = await a.callTool({ name: "browser_status", arguments: { session_id: "another-session" } });
      assert.equal(forged.isError, true);
      const meta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
      const unauthorized = await fetch(`http://127.0.0.1:${meta.port}/rpc`, { method: "POST", body: "{}" });
      assert.equal(unauthorized.status, 403);
      const response = await fetch(`http://127.0.0.1:${meta.port}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${meta.token}` },
        body: JSON.stringify({ operation: "status" }),
      });
      assert.equal((await response.json()).sessions, 2);
      await a.close();
      a = null;
      assert.equal((await status(b)).selection_required, true);
      assert.equal(JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8")).pid, meta.pid);
      const reuse = await b.callTool({ name: "browser_select", arguments: { mode: "reuse" } });
      assert.equal(reuse.isError, true, "existing instance must be selected explicitly by ID");
      assert.deepEqual((await status(b)).instances, []);
      const homeFiles = await readdir(home);
      assert.ok(!homeFiles.includes("extension"));
      assert.ok(!homeFiles.includes("profiles"), "status and invalid selection must not launch Snow");
      assert.match((await b.callTool({ name: "browser_tabs", arguments: {} })).content[0].text, /select|choose/i);
    } finally {
      await a?.close();
      await b?.close();
      await retire(home);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "artifact includes production dependencies and notices, rejects tampering, and contains no project sources or source maps",
  { timeout: 30000 },
  async () => {
    const inventory = JSON.parse(await readFile(path.join(source, "artifact.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    assert.equal(manifest.name, "cdphelper");
    assert.equal(manifest.displayName, "cdpHelper");
    for (const config of ["mcp.json", "mcp.codex.json", ".mcp.json"]) {
      const wiring = JSON.parse(await readFile(path.join(source, config), "utf8"));
      assert.deepEqual(Object.keys(wiring.mcpServers), ["cdphelper"]);
    }
    assert.match(await readFile(path.join(source, "skills/cdphelper/SKILL.md"), "utf8"), /^name: cdphelper$/m);
    assert.ok(Object.keys(inventory.runtime_files).some((f) => f.includes("playwright-core/package.json")));
    assert.ok(Object.keys(inventory.runtime_files).some((f) => f.includes("@modelcontextprotocol/sdk/package.json")));
    const packed = JSON.parse(gunzipSync(await readFile(path.join(source, "runtime.pack.gz"))).toString("utf8"));
    assert.deepEqual(Object.keys(packed), Object.keys(inventory.runtime_files));
    for (const [file, expected] of Object.entries(inventory.runtime_files)) {
      assert.ok(!/\.(?:tsx?|map)$/.test(file), file);
      assert.equal(createHash("sha256").update(Buffer.from(packed[file], "base64")).digest("hex"), expected, file);
    }
    for (const file of Object.keys(inventory.files)) {
      assert.notEqual(
        file,
        "skills/cdphelper/scripts/run.mjs",
        "legacy source-checkout runner must not ship in plugins",
      );
      assert.ok(!/\.(?:tsx?|map)$/.test(file), file);
      assert.ok(!file.split("/").includes("node_modules"), "expanded dependencies must not enter the plugin Git tree");
      assert.ok(!/(?:^|\/)extension\/|bridge-config\.json$|\.zip$|(?:^|\/)manifest\.json$/.test(file), file);
      assert.equal((await lstat(path.join(source, file))).isSymbolicLink(), false, file);
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-plugin-tamper-"));
    try {
      await cp(source, scratch, { recursive: true });
      await writeFile(path.join(scratch, "runtime.pack.gz"), "// tampered\n");
      assert.throws(
        () => execFileSync(process.execPath, [path.join(scratch, "launch.mjs"), "--check"], { stdio: "pipe" }),
        /checksum mismatch/,
      );
      // Even a malformed archive with matching outer checksums cannot escape the runtime cache.
      const malicious = { "../escaped.txt": Buffer.from("escaped").toString("base64") };
      const archive = gzipSync(JSON.stringify(malicious));
      await writeFile(path.join(scratch, "runtime.pack.gz"), archive);
      const forged = structuredClone(inventory);
      forged.files["runtime.pack.gz"] = createHash("sha256").update(archive).digest("hex");
      forged.runtime_files = { "../escaped.txt": createHash("sha256").update("escaped").digest("hex") };
      await writeFile(path.join(scratch, "artifact.json"), JSON.stringify(forged));
      assert.throws(
        () =>
          execFileSync(process.execPath, [path.join(scratch, "launch.mjs"), "--home", path.join(scratch, "home")], {
            stdio: "pipe",
          }),
        /Invalid artifact path/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "marketplace upgrade keeps MCP ready, requires a notice, interrupts old sessions and prevents downgrade",
  { timeout: 60000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-plugin-upgrade-"));
    const home = path.join(scratch, "home");
    const next = path.join(scratch, "next");
    let old, upgraded;
    try {
      await cp(source, next, { recursive: true });
      const packFile = path.join(next, "runtime.pack.gz");
      const packed = JSON.parse(gunzipSync(await readFile(packFile)).toString("utf8"));
      const build = JSON.parse(Buffer.from(packed["build.json"], "base64").toString("utf8"));
      build.version = "9.9.9";
      build.digest = createHash("sha256").update("test runtime upgrade").digest("hex");
      const buildBytes = Buffer.from(JSON.stringify(build));
      packed["build.json"] = buildBytes.toString("base64");
      const archive = gzipSync(JSON.stringify(packed));
      await writeFile(packFile, archive);
      const artifactFile = path.join(next, "artifact.json");
      const artifact = JSON.parse(await readFile(artifactFile, "utf8"));
      artifact.version = build.version;
      artifact.digest = build.digest;
      artifact.runtime_files["build.json"] = createHash("sha256").update(buildBytes).digest("hex");
      artifact.files["runtime.pack.gz"] = createHash("sha256").update(archive).digest("hex");
      await writeFile(artifactFile, JSON.stringify(artifact));
      old = await client(source, home);
      assert.equal((await status(old)).selection_required, true);
      const oldMeta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
      upgraded = await client(next, home);
      assert.ok((await upgraded.listTools()).tools.length > 20);
      const pending = await status(upgraded);
      assert.equal(pending.runtime.state, "upgrade_required");
      assert.equal(pending.instances, null);
      assert.equal(JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8")).pid, oldMeta.pid);
      const acknowledged = await upgraded.callTool({
        name: "browser_status",
        arguments: { acknowledge_upgrade_notice: pending.runtime.upgrade_notice_id },
      });
      assert.ok(!acknowledged.isError, acknowledged.content[0]?.text);
      assert.equal(JSON.parse(acknowledged.content[0].text).runtime.state, "upgrading");
      let completed;
      for (let poll = 0; poll < 100; poll++) {
        completed = await status(upgraded);
        if (completed.runtime.state !== "upgrading") break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(completed.runtime.state, "ready", JSON.stringify(completed));
      const meta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
      assert.match(meta.runtime, /^9\.9\.9:/);
      assert.notEqual(meta.pid, oldMeta.pid);
      assert.equal((await status(old)).runtime.state, "plugin_reload_required");
      assert.ok((await readdir(path.join(home, "runtimes"))).some((v) => v.startsWith("9.9.9-")));
    } finally {
      await old?.close();
      await upgraded?.close();
      await retire(home);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

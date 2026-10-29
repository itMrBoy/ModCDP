import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const source = path.resolve("dist/plugin-marketplace/plugins/cdphelper");
async function client(plugin, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(plugin, "launch.mjs"), "--home", home, "--bridge-port", "0"],
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
      body: JSON.stringify({ operation: "retire" }),
    });
  } catch {}
}

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
      assert.ok(!definitions.tools.some((t) => /run_code|evaluate/.test(t.name)));
      assert.ok(!definitions.tools.some((t) => /configure_extension/.test(t.name)));
      assert.equal((await status(a)).selection_required, true);
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
    assert.ok(Object.keys(inventory.files).some((f) => f.includes("playwright-core/package.json")));
    assert.ok(Object.keys(inventory.files).some((f) => f.includes("@modelcontextprotocol/sdk/package.json")));
    for (const file of Object.keys(inventory.files)) {
      assert.notEqual(
        file,
        "skills/cdphelper/scripts/run.mjs",
        "legacy source-checkout runner must not ship in plugins",
      );
      assert.ok(!/\.(?:tsx?|map)$/.test(file), file);
      assert.ok(!/(?:^|\/)extension\/|bridge-config\.json$|\.zip$|(?:^|\/)manifest\.json$/.test(file), file);
      assert.equal((await lstat(path.join(source, file))).isSymbolicLink(), false, file);
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-plugin-tamper-"));
    try {
      await cp(source, scratch, { recursive: true });
      await writeFile(path.join(scratch, "runtime/cli.mjs"), "// tampered\n");
      assert.throws(
        () => execFileSync(process.execPath, [path.join(scratch, "launch.mjs"), "--check"], { stdio: "pipe" }),
        /checksum mismatch/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "marketplace upgrade refuses to replace active old sessions, then applies a whole new runtime",
  { timeout: 60000 },
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-plugin-upgrade-"));
    const home = path.join(scratch, "home");
    const next = path.join(scratch, "next");
    let old, upgraded;
    try {
      await cp(source, next, { recursive: true });
      const buildFile = path.join(next, "runtime/build.json");
      const build = JSON.parse(await readFile(buildFile, "utf8"));
      build.version = "0.1.2";
      build.digest = createHash("sha256").update("test runtime upgrade").digest("hex");
      await writeFile(buildFile, JSON.stringify(build));
      const artifactFile = path.join(next, "artifact.json");
      const artifact = JSON.parse(await readFile(artifactFile, "utf8"));
      artifact.version = build.version;
      artifact.digest = build.digest;
      artifact.files["runtime/build.json"] = createHash("sha256")
        .update(await readFile(buildFile))
        .digest("hex");
      await writeFile(artifactFile, JSON.stringify(artifact));
      old = await client(source, home);
      await assert.rejects(client(next, home), /older runtime still has active sessions/);
      assert.equal((await status(old)).selection_required, true);
      await old.close();
      old = null;
      upgraded = await client(next, home);
      const meta = JSON.parse(await readFile(path.join(home, "daemon.json"), "utf8"));
      assert.match(meta.runtime, /^0\.1\.2:/);
      assert.ok((await readdir(path.join(home, "runtimes"))).some((v) => v.startsWith("0.1.2-")));
    } finally {
      await old?.close();
      await upgraded?.close();
      await retire(home);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

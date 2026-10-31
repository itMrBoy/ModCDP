import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";
const bundle = path.resolve(".llmdoc-tmp/plugin-tests/service-upgrade.mjs");
await build({
  entryPoints: ["plugin/src/service.mjs"],
  outfile: bundle,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { inspectDaemon, ensureDaemon, rpc, compareRuntimeVersions } = await import(pathToFileURL(bundle).href);
const base = path.resolve(".llmdoc-tmp/plugin-tests");
await mkdir(base, { recursive: true });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function fixture(home, version, digest) {
  const runtime = `${version}:${digest.repeat(64)}`;
  const directory = path.join(home, "runtimes", version + "-" + digest.repeat(16));
  await mkdir(directory, { recursive: true });
  const entry = path.join(directory, "cli.mjs");
  await writeFile(path.join(directory, "build.json"), JSON.stringify({ version, digest: digest.repeat(64) }));
  await writeFile(
    entry,
    `import {runDaemon} from ${JSON.stringify(pathToFileURL(bundle).href)};await runDaemon(${JSON.stringify({ home, runtime, entry, bridgePort: 0, extensionId: "a".repeat(32), extensionVersion: version })});`,
  );
  return { home, runtime, entry, bridgePort: 0 };
}
async function stop(home) {
  const found = await inspectDaemon({ home }).catch(() => null);
  if (found) {
    await rpc(found.meta, "upgrade", {
      expected_runtime: found.meta.runtime,
      target_runtime: "99.0.0:" + "f".repeat(64),
    });
    for (let i = 0; i < 100 && alive(found.meta.pid); i++) await new Promise((r) => setTimeout(r, 100));
  }
}
test("runtime ordering rejects malformed and same-version identities without treating a digest as a version", () => {
  assert.equal(compareRuntimeVersions("0.2.1:" + "a".repeat(64), "0.2.0:" + "b".repeat(64)), 1);
  assert.equal(compareRuntimeVersions("0.2.1:" + "a".repeat(64), "0.2.1:" + "b".repeat(64)), 0);
  assert.throws(() => compareRuntimeVersions("broken", "0.2.1:" + "b".repeat(64)), /identity/);
});
test(
  "notice snapshot gates active backend handover; concurrent replacements reuse one generation and old adapters cannot downgrade",
  { timeout: 40000 },
  async () => {
    const home = await mkdtemp(path.join(base, "upgrade-home-"));
    try {
      const oldConfig = await fixture(home, "1.0.0", "a"),
        newConfig = await fixture(home, "2.0.0", "b");
      const old = await ensureDaemon(oldConfig);
      await rpc(old, "open");
      assert.equal((await inspectDaemon({ home })).status.sessions, 1);
      await assert.rejects(
        ensureDaemon(newConfig),
        (error) => error.code === "PLUGIN_UPGRADE_REQUIRED" && error.snapshot.token === old.token,
      );
      await assert.rejects(
        ensureDaemon(newConfig, { upgradeFrom: { runtime: old.runtime, pid: old.pid, token: "stale" } }),
        (error) => error.code === "PLUGIN_UPGRADE_REQUIRED",
      );
      const upgradeFrom = { runtime: old.runtime, pid: old.pid, token: old.token };
      const [a, b] = await Promise.all([
        ensureDaemon(newConfig, { upgradeFrom }),
        ensureDaemon(newConfig, { upgradeFrom }),
      ]);
      assert.equal(a.pid, b.pid);
      assert.notEqual(a.pid, old.pid);
      assert.equal((await rpc(a, "status")).service_protocol, 1);
      assert.equal((await rpc(a, "status")).sessions, 0);
      assert.equal(alive(old.pid), false);
      await assert.rejects(ensureDaemon(oldConfig), (error) => error.code === "PLUGIN_RELOAD_REQUIRED");
      await assert.rejects(rpc(a, "retire"), /old cdpHelper plugin/);
      await assert.rejects(
        ensureDaemon({ ...newConfig, runtime: "2.0.0:" + "c".repeat(64) }),
        (error) => error.code === "PLUGIN_RUNTIME_CONFLICT",
      );
      await stop(home);
      await assert.rejects(ensureDaemon(oldConfig), (error) => error.code === "PLUGIN_RELOAD_REQUIRED");
    } finally {
      await stop(home);
      await rm(home, { recursive: true, force: true });
    }
  },
);
test("legacy daemon with unverifiable ownership is never terminated", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(base, "legacy-home-"));
  const runtime = "1.0.0:" + "a".repeat(64);
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runtime, pid: process.pid, sessions: 2, closing: false }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const meta = {
    runtime,
    pid: process.pid,
    port: server.address().port,
    token: "test",
    entry: path.join(base, "not-an-owned-runtime.mjs"),
  };
  await writeFile(path.join(home, "daemon.json"), JSON.stringify(meta));
  try {
    const config = await fixture(home, "2.0.0", "b");
    await assert.rejects(ensureDaemon(config, { upgradeFrom: meta }), /ownership|owned|ENOENT/);
    assert.ok(alive(process.pid));
  } finally {
    await new Promise((r) => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "Windows preservation guard runs before cooperative retirement and leaves the old backend usable",
  { timeout: 20000, skip: process.platform !== "win32" },
  async () => {
    const home = await mkdtemp(path.join(base, "preservation-blocked-"));
    try {
      const oldConfig = await fixture(home, "1.0.0", "a");
      const old = await ensureDaemon(oldConfig);
      await rpc(old, "open");
      // An unverified record must fail closed before even asking the old daemon
      // to stop admitting work. The real process-level cases have separate tests.
      await writeFile(path.join(home, "retained.json"), JSON.stringify([{}]));
      const next = await fixture(home, "2.0.0", "b");
      await assert.rejects(ensureDaemon(next, { upgradeFrom: old }), (error) => {
        assert.equal(error.code, "PLUGIN_BROWSER_PRESERVATION_BLOCKED");
        assert.equal(error.backend_runtime, old.runtime);
        assert.match(error.message, /1\.0\.0.*2\.0\.0.*保留/);
        return true;
      });
      assert.ok(alive(old.pid));
      assert.equal((await inspectDaemon({ home })).meta.pid, old.pid);
      assert.ok((await rpc(old, "open")).session_id, "Old daemon still accepts work after refused handover");
      await writeFile(path.join(home, "retained.json"), "[]");
      const upgraded = await ensureDaemon(next, { upgradeFrom: old });
      assert.notEqual(upgraded.pid, old.pid);
    } finally {
      await stop(home);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "cooperative upgrade terminates only its own daemon when broker cleanup hangs, within the ten second budget",
  { timeout: 25000 },
  async () => {
    const home = await mkdtemp(path.join(base, "hung-cleanup-home-"));
    try {
      const exposed = path.join(home, "service-with-broker.mjs");
      await build({
        stdin: {
          contents: `export {runDaemon} from ${JSON.stringify(path.resolve("plugin/src/service.mjs"))};export {BrowserBroker} from ${JSON.stringify(path.resolve("plugin/src/broker.mjs"))};`,
          resolveDir: process.cwd(),
        },
        outfile: exposed,
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const oldConfig = await fixture(home, "1.0.0", "a");
      const marker = path.join(home, "cleanup-started");
      await writeFile(
        oldConfig.entry,
        `import {runDaemon,BrowserBroker} from ${JSON.stringify(pathToFileURL(exposed).href)};import fs from 'node:fs/promises';const close=BrowserBroker.prototype.close;BrowserBroker.prototype.close=async function(){await fs.writeFile(${JSON.stringify(marker)},'cleanup started');await close.call(this);await new Promise(()=>{});};await runDaemon(${JSON.stringify({ ...oldConfig, extensionId: "a".repeat(32), extensionVersion: "1.0.0" })});`,
      );
      const old = await ensureDaemon(oldConfig);
      await rpc(old, "open");
      const started = Date.now();
      const next = await ensureDaemon(await fixture(home, "2.0.0", "b"), { upgradeFrom: old });
      assert.equal(await readFile(marker, "utf8"), "cleanup started");
      assert.ok(Date.now() - started >= 9500, "hang did not bypass the cooperative cleanup budget");
      assert.ok(Date.now() - started < 15000, "upgrade returned without unbounded cleanup");
      assert.equal(alive(old.pid), false);
      assert.equal((await rpc(next, "status")).runtime, "2.0.0:" + "b".repeat(64));
      assert.equal(alive(process.pid), true);
    } finally {
      await stop(home);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "cooperative upgrade observes self-exit beyond ten seconds before using signal fallback",
  { timeout: 25000 },
  async () => {
    const home = await mkdtemp(path.join(base, "exit-observation-home-"));
    let old;
    try {
      const oldConfig = await fixture(home, "1.0.0", "a");
      const marker = path.join(home, "self-exited");
      await writeFile(
        oldConfig.entry,
        `import http from 'node:http';import fs from 'node:fs/promises';
        const runtime=${JSON.stringify(oldConfig.runtime)};
        let retiring=false;
        const server=http.createServer(async(req,res)=>{
          let raw='';for await(const chunk of req)raw+=chunk;
          const {operation}=JSON.parse(raw);
          res.setHeader('content-type','application/json');
          if(operation==='upgrade'){
            res.end(JSON.stringify({retiring:true}));
            if(!retiring){retiring=true;setTimeout(async()=>{
              await fs.writeFile(${JSON.stringify(marker)},'self-exited');process.exit(0);
            },10500);}
          }else res.end(JSON.stringify({runtime,pid:process.pid,sessions:0,closing:retiring,service_protocol:1}));
        });
        await new Promise(r=>server.listen(0,'127.0.0.1',r));
        await fs.writeFile(${JSON.stringify(path.join(home, "daemon.json"))},JSON.stringify({runtime,pid:process.pid,port:server.address().port,token:'exit-observation',entry:${JSON.stringify(oldConfig.entry)},service_protocol:1}));`,
      );
      old = await ensureDaemon(oldConfig);
      const started = Date.now();
      const next = await ensureDaemon(await fixture(home, "2.0.0", "b"), { upgradeFrom: old });
      assert.equal(
        await readFile(marker, "utf8"),
        "self-exited",
        "the old daemon exits itself without an early signal",
      );
      assert.equal(alive(old.pid), false);
      assert.ok(Date.now() - started < 15000, "exit observation remains bounded");
      assert.equal((await rpc(next, "status")).runtime, "2.0.0:" + "b".repeat(64));
    } finally {
      // Even when the assertion fails, let this fixture's scheduled self-exit
      // finish before removing its runtime. Do not bypass ownership with a kill.
      for (let i = 0; old && alive(old.pid) && i < 120; i++) await new Promise((r) => setTimeout(r, 100));
      await stop(home);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "verified legacy Windows daemon is migrated without terminating its parent host",
  { timeout: 20000, skip: process.platform !== "win32" },
  async () => {
    const home = await mkdtemp(path.join(base, "owned-legacy-home-"));
    let child;
    try {
      const oldConfig = await fixture(home, "1.0.0", "a");
      await writeFile(
        oldConfig.entry,
        `
      import http from 'node:http'; import fs from 'node:fs/promises';
      const runtime=${JSON.stringify(oldConfig.runtime)};
      const server=http.createServer(async(req,res)=>{for await(const chunk of req){};res.setHeader('content-type','application/json');res.end(JSON.stringify({runtime,pid:process.pid,sessions:2,closing:false}));});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      await fs.writeFile(${JSON.stringify(path.join(home, "daemon.json"))},JSON.stringify({runtime,pid:process.pid,port:server.address().port,token:'legacy-test',entry:${JSON.stringify(oldConfig.entry)}}));
    `,
      );
      child = spawn(process.execPath, [oldConfig.entry, "--daemon", "--home", home, "--bridge-port", "0"], {
        stdio: "ignore",
      });
      let old;
      for (let i = 0; i < 50; i++) {
        old = await inspectDaemon({ home });
        if (old) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(old.meta.pid, child.pid);
      const next = await fixture(home, "2.0.0", "b");
      const upgraded = await ensureDaemon(next, { upgradeFrom: old.meta });
      assert.notEqual(upgraded.pid, child.pid);
      assert.equal(alive(process.pid), true);
      assert.equal(alive(child.pid), false);
    } finally {
      if (child && alive(child.pid)) child.kill();
      await stop(home);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("in-flight old tool cannot report successful completion after the upgrade fence", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(base, "inflight-home-"));
  try {
    const exposed = path.join(home, "service-with-broker.mjs");
    await build({
      stdin: {
        contents: `export {runDaemon} from ${JSON.stringify(path.resolve("plugin/src/service.mjs"))};export {BrowserBroker} from ${JSON.stringify(path.resolve("plugin/src/broker.mjs"))};`,
        resolveDir: process.cwd(),
      },
      outfile: exposed,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const config = await fixture(home, "1.0.0", "a");
    const marker = path.join(home, "call-started");
    await writeFile(
      config.entry,
      `import {runDaemon,BrowserBroker} from ${JSON.stringify(pathToFileURL(exposed).href)};import fs from 'node:fs/promises';BrowserBroker.prototype.call=async()=>{await fs.writeFile(${JSON.stringify(marker)},'started');await new Promise(r=>setTimeout(r,300));return {completed:true};};const close=BrowserBroker.prototype.close;BrowserBroker.prototype.close=async function(){await new Promise(r=>setTimeout(r,700));await close.call(this);};await runDaemon(${JSON.stringify({ ...config, extensionId: "a".repeat(32), extensionVersion: "1.0.0" })});`,
    );
    const meta = await ensureDaemon(config);
    const { session_id } = await rpc(meta, "open");
    const pending = rpc(meta, "tool", { session_id, name: "browser_wait", args: {} }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    for (let i = 0; i < 30; i++) {
      try {
        await readFile(marker);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await rpc(meta, "upgrade", { expected_runtime: meta.runtime, target_runtime: "2.0.0:" + "b".repeat(64) });
    const result = await pending;
    assert.equal(result.value, undefined);
    assert.match(result.error.message, /interrupted by backend upgrade/);
    for (let i = 0; i < 30 && alive(meta.pid); i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    await stop(home);
    await rm(home, { recursive: true, force: true });
  }
});

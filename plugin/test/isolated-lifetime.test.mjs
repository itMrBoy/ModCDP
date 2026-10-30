import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { assertBrowserLifetimePreserved } from "../src/isolated.mjs";

const run = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function stopOwned(pid, token) {
  if (!pid || !alive(pid)) return;
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 15000 },
  );
  assert.ok(JSON.parse(stdout).CommandLine.includes(token), "Refusing to terminate a reused test PID");
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && alive(pid); i++) await delay(100);
  assert.equal(alive(pid), false);
}

test(
  "production browser spawn survives its daemon parent exiting on Windows",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const directory = await mkdtemp(path.join(base, "independent-browser-"));
    const token = randomUUID(),
      receipt = path.join(directory, "child.json");
    const childScript = path.join(directory, "child.mjs"),
      parentScript = path.join(directory, "parent.mjs");
    let parent, childPid;
    try {
      await writeFile(childScript, "setInterval(()=>{},1000);");
      await writeFile(
        parentScript,
        `import{spawnIndependentBrowser}from${JSON.stringify(pathToFileURL(path.resolve("plugin/src/isolated.mjs")).href)};import{writeFile}from'node:fs/promises';const child=spawnIndependentBrowser(process.execPath,${JSON.stringify([childScript, token])});await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j)});await writeFile(${JSON.stringify(receipt)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`,
      );
      parent = spawn(process.execPath, [parentScript, token], { detached: true, stdio: "ignore", windowsHide: true });
      parent.unref();
      for (let i = 0; i < 50; i++) {
        try {
          childPid = JSON.parse(await readFile(receipt, "utf8")).pid;
          break;
        } catch {}
        await delay(100);
      }
      assert.ok(childPid && alive(childPid));
      await stopOwned(parent.pid, token);
      await delay(500);
      assert.equal(alive(childPid), true, "Browser child must survive daemon retirement");
    } finally {
      await stopOwned(parent?.pid, token);
      await stopOwned(childPid, token);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows lifetime guard blocks live legacy browsers and uncertain ownership, permits detached or exited browsers",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const home = await mkdtemp(path.join(base, "lifetime-guard-"));
    const token = randomUUID();
    let child;
    try {
      const profile = path.join(home, "profiles", "isolated-fixture");
      await mkdir(profile, { recursive: true });
      const executable = path.join(home, "snowview.exe"),
        script = path.join(home, "child.mjs");
      await copyFile(await realpath(process.execPath), executable);
      await writeFile(script, "setInterval(()=>{},1000);");
      child = spawn(executable, [script, `--user-data-dir=${profile}`, token], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise((r, j) => {
        child.once("spawn", r);
        child.once("error", j);
      });
      child.unref();
      const record = { instance_id: token, profile, executable, pid: child.pid, mode: "isolated" };
      const save = async (marker = record) => {
        await writeFile(path.join(home, "retained.json"), JSON.stringify([record]));
        await writeFile(path.join(profile, ".cdphelper-owner.json"), JSON.stringify(marker));
      };
      await save();
      await assert.rejects(assertBrowserLifetimePreserved(home), /依赖旧后台/);
      assert.ok(alive(child.pid), "Guard must not terminate the browser");
      record.lifetime_detached = true;
      await save({ ...record, lifetime_detached: false });
      await assert.rejects(assertBrowserLifetimePreserved(home), /依赖旧后台/);
      await save();
      await assertBrowserLifetimePreserved(home);
      await save({ ...record, instance_id: "incorrect" });
      await assert.rejects(assertBrowserLifetimePreserved(home), /ownership/);
      delete record.lifetime_detached;
      await save();
      await stopOwned(child.pid, token);
      await assertBrowserLifetimePreserved(home);
      await writeFile(path.join(home, "retained.json"), JSON.stringify([{ mode: "reuse" }]));
      await assertBrowserLifetimePreserved(home);
      await writeFile(path.join(home, "retained.json"), "{}");
      await assert.rejects(assertBrowserLifetimePreserved(home), /记录无法核验/);
    } finally {
      await stopOwned(child?.pid, token);
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);

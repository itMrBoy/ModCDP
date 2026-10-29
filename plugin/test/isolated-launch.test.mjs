import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("isolated GUI launch requests a visible window and retains its exact owned profile", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cdphelper-visible-launch-"));
  try {
    const executable = path.join(scratch, process.platform === "win32" ? "snowview.exe" : "snowview");
    await writeFile(executable, "mocked GUI executable; never executed");
    // Isolate the built-in spawn mock in a child so parallel tests cannot inherit it.
    const script = `
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {EventEmitter} from 'node:events';
      let launched;
      childProcess.spawn=(executable,args,options)=>{
        launched={executable,args,options};
        const child=new EventEmitter(); child.pid=123; child.unref=()=>{};
        process.nextTick(()=>child.emit('spawn')); return child;
      };
      syncBuiltinESMExports();
      const {launchIsolated}=await import(process.argv[3]);
      const {record}=await launchIsolated(process.argv[2],'owned-test',process.argv[1],'http://127.0.0.1:12345/initialize/test');
      console.log(JSON.stringify({launched,record}));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        executable,
        path.join(scratch, "home"),
        pathToFileURL(path.resolve("plugin/src/isolated.mjs")).href,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const { launched, record } = JSON.parse(stdout);
    assert.equal(launched.options.windowsHide, false, "A live hidden process is not a usable browser window");
    assert.equal(launched.executable, executable);
    assert.equal(launched.args[0], `--user-data-dir=${record.profile}`);
    assert.equal(launched.args.at(-1), "http://127.0.0.1:12345/initialize/test");
    assert.deepEqual(JSON.parse(await readFile(path.join(record.profile, ".cdphelper-owner.json"), "utf8")), record);
  } finally {
    assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
    await rm(scratch, { recursive: true, force: true });
  }
});

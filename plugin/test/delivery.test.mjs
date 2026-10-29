import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { deliverPlugin, replaceManagedEntries } from "../../js/scripts/deliver-plugin.mjs";

const entries = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "plugins/cdphelper"];
const distributionURL = "https://github.com/itMrBoy/cdpHelper.git";

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
}

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdphelper-delivery-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function write(directory, relative, text) {
  const file = path.join(directory, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function init(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.email", "delivery-test@example.invalid");
  git(directory, "config", "user.name", "Delivery test");
  git(directory, "config", "commit.gpgsign", "false");
  git(directory, "config", "core.autocrlf", "false");
  git(directory, "config", "core.hooksPath", path.join(directory, ".git", "empty-hooks"));
}

async function commit(directory) {
  git(directory, "add", "--all");
  git(directory, "commit", "-m", "fixture");
}

async function repository(t) {
  const root = await workspace(t);
  await init(root);
  const target = path.join(root, "cdpHelper");
  await init(target);
  git(target, "remote", "add", "origin", distributionURL);
  await write(target, "README.md", "maintained separately\n");
  await commit(target);
  await write(root, ".gitmodules", `[submodule "cdpHelper"]\n\tpath = cdpHelper\n\turl = ${distributionURL}\n`);
  await write(root, "plugin/version.json", '{"version":"0.1.1"}\n');
  git(root, "add", ".gitmodules", "plugin/version.json");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(target, "rev-parse", "HEAD")},cdpHelper`);
  git(root, "commit", "-m", "source fixture");
  return { root, target };
}

async function snapshot(directory, prefix = "") {
  const files = {};
  for (const item of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (item.name === ".git") continue;
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) Object.assign(files, await snapshot(directory, relative));
    else files[relative] = (await fs.readFile(path.join(directory, relative))).toString("base64");
  }
  return files;
}

async function marketplace(directory, label) {
  await write(directory, entries[0], `${label}:codex\n`);
  await write(directory, entries[1], `${label}:claude\n`);
  await write(directory, "plugins/cdphelper/launch.mjs", `${label}:launch\n`);
  await write(directory, "plugins/cdphelper/runtime.pack.gz", `${label}:packed-runtime\n`);
}

test("delivery refuses dirty source and destination before invoking the build", async (t) => {
  for (const dirty of ["source", "destination"]) {
    await t.test(dirty, async (t) => {
      const { root, target } = await repository(t);
      await write(dirty === "source" ? root : target, "uncommitted.txt", "preserve this\n");
      const before = await snapshot(root);
      let builds = 0;
      await assert.rejects(deliverPlugin({ root, build: async () => builds++ }));
      assert.equal(builds, 0, "preflight must reject before starting a build");
      assert.deepEqual(await snapshot(root), before);
    });
  }
});

test("delivery refuses a child HEAD different from the parent gitlink", async (t) => {
  const { root, target } = await repository(t);
  await write(target, "README.md", "new child commit\n");
  await commit(target);
  let builds = 0;
  await assert.rejects(deliverPlugin({ root, build: async () => builds++ }));
  assert.equal(builds, 0);
  assert.equal(await fs.readFile(path.join(target, "README.md"), "utf8"), "new child commit\n");
});

test("delivery refuses ignored local dependencies inside managed paths before building", async (t) => {
  const { root, target } = await repository(t);
  await write(target, ".gitignore", "node_modules/\n");
  await commit(target);
  git(root, "update-index", "--cacheinfo", `160000,${git(target, "rev-parse", "HEAD")},cdpHelper`);
  git(root, "commit", "-m", "update child fixture");
  const relative = "plugins/cdphelper/node_modules/local/index.js";
  await write(target, relative, "preserve ignored local dependency\n");
  assert.equal(git(target, "status", "--porcelain"), "", "ignored data must not appear as a dirty checkout");
  let builds = 0;
  await assert.rejects(deliverPlugin({ root, build: async () => builds++ }));
  assert.equal(builds, 0);
  assert.equal(await fs.readFile(path.join(target, relative), "utf8"), "preserve ignored local dependency\n");
});

test("delivery refuses an uninitialized child without populating it", async (t) => {
  const { root, target } = await repository(t);
  // Preserve the fixture repository outside the tracked child path, as deinit would.
  const saved = path.join(await workspace(t), "saved-child");
  await fs.rename(target, saved);
  await fs.mkdir(target);
  let builds = 0;
  await assert.rejects(deliverPlugin({ root, build: async () => builds++ }));
  assert.equal(builds, 0);
  assert.deepEqual(await fs.readdir(target), []);
});

test("an existing delivery lock prevents building and is preserved for inspection", async (t) => {
  const { root, target } = await repository(t);
  const lock = path.join(git(target, "rev-parse", "--absolute-git-dir"), "cdphelper-delivery.lock");
  await fs.mkdir(lock);
  await write(lock, "owner.json", '{"pid":1234,"source_commit":"existing delivery"}\n');
  let builds = 0;
  await assert.rejects(deliverPlugin({ root, build: async () => builds++ }), /Delivery already running/);
  assert.equal(builds, 0);
  assert.equal(
    await fs.readFile(path.join(lock, "owner.json"), "utf8"),
    '{"pid":1234,"source_commit":"existing delivery"}\n',
  );
});

test("replacement updates only the managed entries and removes stale plugin files", async (t) => {
  const base = await workspace(t);
  const source = path.join(base, "candidate");
  const target = path.join(base, "distribution");
  await init(target);
  await marketplace(source, "new");
  await marketplace(target, "old");
  await write(target, "plugins/cdphelper/stale.mjs", "must disappear\n");
  await write(target, "README.md", "human documentation\n");
  await write(target, ".agents/plugins/other.json", "other plugin\n");
  await commit(target);
  const head = git(target, "rev-parse", "HEAD");
  await replaceManagedEntries({ source, target });
  for (const [relative, content] of Object.entries(await snapshot(source))) {
    assert.equal((await fs.readFile(path.join(target, relative))).toString("base64"), content);
  }
  await assert.rejects(fs.access(path.join(target, "plugins/cdphelper/stale.mjs")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(target, "README.md"), "utf8"), "human documentation\n");
  assert.equal(await fs.readFile(path.join(target, ".agents/plugins/other.json"), "utf8"), "other plugin\n");
  assert.equal(git(target, "rev-parse", "HEAD"), head, "delivery must not create a commit");
});

test("a mid-replacement failure restores all previous generated bytes", async (t) => {
  const base = await workspace(t);
  const source = path.join(base, "candidate");
  const target = path.join(base, "distribution");
  await init(target);
  await marketplace(source, "new");
  await marketplace(target, "old");
  await write(target, "plugins/cdphelper/old-only.mjs", "preserve during rollback\n");
  await write(target, "README.md", "preserve README\n");
  const before = await snapshot(target);
  let renames = 0;
  const io = {
    ...fs,
    rename: async (...args) => {
      if (++renames === 4) throw new Error("injected replacement failure");
      return fs.rename(...args);
    },
  };
  await assert.rejects(replaceManagedEntries({ source, target }, io), /injected replacement failure/);
  assert.ok(renames >= 4, "failure must occur after replacement has begun");
  assert.deepEqual(await snapshot(target), before);
});

test("a corrupted staged file is rejected and the previous generated files are restored", async (t) => {
  const base = await workspace(t);
  const source = path.join(base, "candidate");
  const target = path.join(base, "distribution");
  await init(target);
  await marketplace(source, "new");
  await marketplace(target, "old");
  await write(target, "README.md", "preserve documentation\n");
  const before = await snapshot(target);
  let corrupted = false;
  const io = {
    ...fs,
    cp: async (...args) => {
      await fs.cp(...args);
      if (path.basename(args[1]) === "new-2") {
        await fs.writeFile(path.join(args[1], "launch.mjs"), "corrupted staged bytes\n");
        corrupted = true;
      }
    },
  };
  await assert.rejects(replaceManagedEntries({ source, target }, io), /checksum/);
  assert.equal(corrupted, true);
  assert.deepEqual(await snapshot(target), before);
});

test("replacement rejects a linked managed destination and preserves files outside it", async (t) => {
  const base = await workspace(t);
  const source = path.join(base, "candidate");
  const target = path.join(base, "distribution");
  const outside = path.join(base, "outside");
  await init(target);
  await marketplace(source, "new");
  await marketplace(target, "old");
  await write(outside, "sentinel.txt", "outside owned files\n");
  await fs.rm(path.join(target, "plugins/cdphelper"), { recursive: true });
  await fs.symlink(outside, path.join(target, "plugins/cdphelper"), process.platform === "win32" ? "junction" : "dir");
  const before = await snapshot(outside);
  await assert.rejects(replaceManagedEntries({ source, target }));
  assert.deepEqual(await snapshot(outside), before);
  assert.equal(await fs.readFile(path.join(target, entries[0]), "utf8"), "old:codex\n");
});

test("replacement rejects linked candidate content before changing the destination", async (t) => {
  const base = await workspace(t);
  const source = path.join(base, "candidate");
  const target = path.join(base, "distribution");
  const outside = path.join(base, "outside");
  await init(target);
  await marketplace(source, "new");
  await marketplace(target, "old");
  await write(outside, "launch.mjs", "linked untrusted input\n");
  await fs.rm(path.join(source, "plugins/cdphelper"), { recursive: true });
  await fs.symlink(outside, path.join(source, "plugins/cdphelper"), process.platform === "win32" ? "junction" : "dir");
  const before = await snapshot(target);
  await assert.rejects(replaceManagedEntries({ source, target }), /Linked delivery path/);
  assert.deepEqual(await snapshot(target), before);
  assert.equal(await fs.readFile(path.join(outside, "launch.mjs"), "utf8"), "linked untrusted input\n");
});

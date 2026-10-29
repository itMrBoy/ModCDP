import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { releaseNotes } from "../../js/scripts/release-notes.mjs";

function git(source, ...args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
}
async function repository(t) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "cdphelper-notes-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Release test");
  git(source, "config", "user.email", "release@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "core.hooksPath", path.join(source, ".git", "empty-hooks"));
  return source;
}
async function add(source, subject, file = "plugin/change.txt") {
  await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
  await fs.appendFile(path.join(source, file), subject + "\n");
  git(source, "add", "--all");
  git(source, "commit", "-m", subject);
  return git(source, "rev-parse", "HEAD");
}
function options(source, sourceCommit, overrides = {}) {
  return {
    source,
    sourceCommit,
    version: "0.1.2",
    distributionCommit: "b".repeat(40),
    assetName: "cdphelper-extension-v0.1.2.zip",
    artifactSha256: "c".repeat(64),
    ...overrides,
  };
}

test("notes use the source range, Chinese categories and relevant paths, not distribution commits", async (t) => {
  const source = await repository(t);
  const previous = await add(source, "feat: 旧功能");
  await add(source, "feat: 新增标签页");
  await add(source, "fix: 修复连接");
  await add(source, "chore: 同步分发产物", "cdpHelper/artifact.json");
  const current = await add(source, "docs: 安装说明", "README.zh-CN.md");
  const notes = await releaseNotes(options(source, current, { previousSourceCommit: previous, previousTag: "v0.1.1" }));
  assert.match(notes, /### 新增功能/);
  assert.match(notes, /### 问题修复/);
  assert.match(notes, /### 文档更新/);
  assert.match(notes, /共 3 条/);
  assert.doesNotMatch(notes, /旧功能|同步分发产物/);
  assert.ok(notes.includes(`/compare/${previous}...${current}`));
  assert.ok(notes.includes(`/releases/tag/v0.1.1`));
  assert.match(notes, /extension\/ 子目录/);
  assert.match(notes, /无需 npm\/pnpm install/);
  assert.match(notes, /真实雪诺隔离启动尚未通过验收/);
});

test("first release explicitly has no previous baseline and escapes commit Markdown", async (t) => {
  const source = await repository(t);
  const current = await add(source, "feat: [link](javascript:x) <b> & `code` $(echo nope)");
  const notes = await releaseNotes(options(source, current));
  assert.match(notes, /首次发布，无上一版源码基线/);
  assert.ok(notes.includes("\\[link\\]\\(javascript:x\\) \\<b\\> &amp; \\`code\\` $\\(echo nope\\)"));
  assert.doesNotMatch(notes, /compare\//);
  assert.match(notes, /不代表完整历史/);
});

test("divergent or missing previous source fails instead of generating unrelated history", async (t) => {
  const source = await repository(t);
  const base = await add(source, "feat: base");
  const current = await add(source, "fix: main");
  git(source, "checkout", "-b", "side", base);
  const other = await add(source, "feat: side");
  await assert.rejects(releaseNotes(options(source, current, { previousSourceCommit: other })), /ancestor/);
  await assert.rejects(releaseNotes(options(source, current, { previousSourceCommit: "f".repeat(40) })));
});

test("invalid external identifiers cannot become git arguments or release links", async (t) => {
  const source = await repository(t);
  const current = await add(source, "feat: base");
  for (const change of [
    { sourceCommit: "--all" },
    { version: "1.2.3; echo bad" },
    { distributionCommit: "not-a-sha" },
    { assetName: "../outside.zip" },
    { previousTag: "v1.0.0]bad" },
  ]) {
    await assert.rejects(releaseNotes(options(source, current, change)));
  }
});

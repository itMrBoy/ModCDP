import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { validateMarketplace } from "./deliver-plugin.mjs";
import { releaseNotes } from "./release-notes.mjs";

const repository = "itMrBoy/cdpHelper";
const managed = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "plugins/cdphelper"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJSON = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJSON = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
const command = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...options,
  }).trim();
const git = (root, ...args) => command("git", ["-C", root, ...args]);
function requireValue(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
const sha = (value) => requireValue(value, /^[a-f0-9]{40}$/, "commit SHA");
const versionNumber = (value) => requireValue(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "release version");
function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`Release ${label} does not match the selected distribution.`);
}
function clean(root) {
  if (git(root, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"))
    throw new Error(`Release checkout must be clean: ${root}`);
}
async function inventory(root, prefix = "") {
  const result = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await inventory(path.join(root, entry.name), relative + "/"));
    else if (entry.isFile()) result[relative] = hash(await fs.readFile(path.join(root, entry.name)));
    else throw new Error(`Linked or unsupported release file: ${relative}`);
  }
  return result;
}
export function distributionGitlink(tooling) {
  const match = /^160000 commit ([a-f0-9]{40})\tcdpHelper$/.exec(git(tooling, "ls-tree", "HEAD", "cdpHelper"));
  if (!match) throw new Error("The merged commit must pin the cdpHelper submodule.");
  return match[1];
}
export async function releaseMetadata({ tooling, distribution }) {
  clean(distribution);
  const distributionCommit = distributionGitlink(tooling);
  equal(git(distribution, "rev-parse", "HEAD"), distributionCommit, "distribution commit");
  const artifact = await readJSON(path.join(distribution, "plugins/cdphelper/artifact.json"));
  const version = versionNumber(artifact.version);
  equal(
    (await readJSON(path.join(tooling, "plugin/version.json"))).version,
    version,
    "version; deliver the new version first",
  );
  equal(artifact.source_dirty, false, "clean source");
  return {
    version,
    tag: `v${version}`,
    source_commit: sha(artifact.source_commit),
    distribution_commit: distributionCommit,
  };
}
function compareVersions(a, b) {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
async function downloadManifest(tag, run = command) {
  return JSON.parse(
    await run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      "release-manifest.json",
      "--output",
      "-",
    ]),
  );
}
export async function previousRelease(version, run = command) {
  const releases = JSON.parse(
    await run("gh", [
      "release",
      "list",
      "--repo",
      repository,
      "--exclude-drafts",
      "--exclude-pre-releases",
      "--limit",
      "1000",
      "--json",
      "tagName",
    ]),
  );
  const versions = releases.map((item) => item.tagName).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (versions.some((tag) => compareVersions(tag.slice(1), version) > 0))
    throw new Error("A newer extension version is already published. Refusing an out-of-order release.");
  const tag = versions
    .filter((item) => compareVersions(item.slice(1), version) < 0)
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0];
  if (!tag) return null;
  const manifest = await downloadManifest(tag, run);
  equal(manifest.plugin_version, tag.slice(1), "previous release version");
  equal(manifest.source_dirty, false, "previous release clean source");
  sha(manifest.source_commit);
  return { ...manifest, release_tag: tag };
}

// Build uses A; the plugin checksum is always taken from the committed distribution B.
export async function prepareRelease({ tooling, source, distribution, output, previousManifest = null }) {
  const metadata = await releaseMetadata({ tooling, distribution });
  clean(source);
  equal(git(source, "rev-parse", "HEAD"), metadata.source_commit, "build source commit");
  const built = await readJSON(path.join(source, "dist/releases/release-manifest.json"));
  equal(built.source_commit, metadata.source_commit, "extension source commit");
  equal(built.source_dirty, false, "extension clean source");
  equal(built.extension_version, metadata.version, "extension version");
  equal(built.extension.filename, `cdphelper-extension-v${metadata.version}.zip`, "extension filename");
  const pluginRoot = path.join(distribution, "plugins/cdphelper");
  const artifact = await readJSON(path.join(pluginRoot, "artifact.json"));
  const packed = JSON.parse(
    gunzipSync(await fs.readFile(path.join(pluginRoot, "runtime.pack.gz")), {
      maxOutputLength: 256 * 1024 * 1024,
    }).toString("utf8"),
  );
  const runtime = JSON.parse(Buffer.from(packed["build.json"], "base64").toString("utf8"));
  equal(built.protocol_version, runtime.protocol_version, "bridge protocol");
  equal(built.extension.expected_extension_id, runtime.expected_extension_id, "extension identity");
  const actualExtension = await inventory(path.join(source, "dist/extension"));
  equal(JSON.stringify(actualExtension), JSON.stringify(built.extension.files), "compiled extension file checksums");
  output = path.resolve(output);
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length)
    throw new Error("Release output must be empty; preserve the previous bundle before retrying.");
  const assets = path.join(output, "assets");
  await fs.mkdir(assets);
  const extension = path.join(assets, built.extension.filename);
  await fs.copyFile(path.join(source, "dist/releases", built.extension.filename), extension);
  equal(hash(await fs.readFile(extension)), built.extension.sha256, "extension ZIP checksum");
  const stage = await fs.mkdtemp(path.join(output, ".verify-"));
  try {
    for (const entry of managed) {
      const target = path.join(stage, "dist/plugin-marketplace", entry);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(path.join(distribution, entry), target, { recursive: true, dereference: false });
    }
    await fs.mkdir(path.join(stage, "plugin"));
    await writeJSON(path.join(stage, "plugin/version.json"), { version: metadata.version });
    const marketplace = await inventory(path.join(stage, "dist/plugin-marketplace"));
    const manifest = {
      ...built,
      distribution_commit: metadata.distribution_commit,
      distribution_repository_url: `https://github.com/${repository}`,
      marketplace_inventory_sha256: hash(JSON.stringify(marketplace)),
      plugin_artifact: {
        path: "../plugin-marketplace/plugins/cdphelper/artifact.json",
        sha256: hash(await fs.readFile(path.join(pluginRoot, "artifact.json"))),
        digest: artifact.digest,
      },
      previous_source_commit: previousManifest?.source_commit ?? null,
      previous_release_tag: previousManifest?.release_tag ?? null,
    };
    await writeJSON(path.join(assets, "release-manifest.json"), manifest);
    const manifestHash = hash(await fs.readFile(path.join(assets, "release-manifest.json")));
    await fs.writeFile(
      path.join(assets, "SHA256SUMS"),
      `${built.extension.sha256}  ${built.extension.filename}\n${manifestHash}  release-manifest.json\n`,
    );
    await fs.cp(assets, path.join(stage, "dist/releases"), { recursive: true });
    await validateMarketplace({ root: stage, sourceCommit: metadata.source_commit });
    const notes = await releaseNotes({
      source,
      version: metadata.version,
      sourceCommit: metadata.source_commit,
      distributionCommit: metadata.distribution_commit,
      previousSourceCommit: previousManifest?.source_commit,
      previousTag: previousManifest?.release_tag,
      assetName: built.extension.filename,
      artifactSha256: manifest.plugin_artifact.sha256,
    });
    const marker = `<!-- cdphelper-release ${metadata.tag} ${metadata.source_commit} ${metadata.distribution_commit} ${manifest.plugin_artifact.sha256} -->`;
    await fs.writeFile(path.join(output, "release-notes.md"), marker + "\n\n" + notes);
    const plan = {
      ...metadata,
      previous_release_tag: manifest.previous_release_tag,
      artifact_sha256: manifest.plugin_artifact.sha256,
      marker,
      notes_sha256: hash(await fs.readFile(path.join(output, "release-notes.md"))),
      assets: await inventory(assets),
    };
    await writeJSON(path.join(output, "release-plan.json"), plan);
    return plan;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function publishRelease({ bundle, run = command }) {
  const plan = await readJSON(path.join(bundle, "release-plan.json"));
  versionNumber(plan.version);
  sha(plan.source_commit);
  sha(plan.distribution_commit);
  equal(plan.tag, `v${plan.version}`, "tag");
  const expectedFiles = [`cdphelper-extension-v${plan.version}.zip`, "release-manifest.json", "SHA256SUMS"].sort();
  equal(Object.keys(plan.assets).sort().join(), expectedFiles.join(), "asset inventory");
  const assets = path.join(bundle, "assets");
  equal(
    Object.keys(await inventory(assets))
      .sort()
      .join(),
    expectedFiles.join(),
    "bundle files",
  );
  for (const file of expectedFiles)
    equal(hash(await fs.readFile(path.join(assets, file))), plan.assets[file], "asset checksum");
  const manifest = await readJSON(path.join(assets, "release-manifest.json"));
  equal(manifest.source_commit, plan.source_commit, "bundle source");
  equal(manifest.distribution_commit, plan.distribution_commit, "bundle distribution");
  equal(manifest.plugin_artifact.sha256, plan.artifact_sha256, "bundle artifact");
  equal(hash(await fs.readFile(path.join(bundle, "release-notes.md"))), plan.notes_sha256, "release notes checksum");
  const releases = JSON.parse(
    await run("gh", [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      "1000",
      "--json",
      "tagName,isDraft,isPrerelease",
    ]),
  );
  const existing = releases.find((item) => item.tagName === plan.tag);
  if (existing?.isPrerelease && !existing.isDraft)
    throw new Error("This version tag is already a public prerelease. Use a new version for the stable release.");
  async function verifyTag(expected, required = false) {
    const tags = await run("git", [
      "ls-remote",
      `https://github.com/${repository}.git`,
      `refs/tags/${plan.tag}`,
      `refs/tags/${plan.tag}^{}`,
    ]);
    if (!tags) {
      if (required) throw new Error("Published release tag is missing; inspect it before retrying.");
      return;
    }
    const lines = tags.trim().split(/\r?\n/);
    const target = (lines.find((line) => line.endsWith("^{}")) ?? lines[0]).split(/\s/)[0];
    equal(target, expected, "existing tag target");
  }
  if (existing && !existing.isDraft) {
    const remote = await downloadManifest(plan.tag, run);
    equal(
      remote.source_commit,
      plan.source_commit,
      "published version source; bump the version instead of replacing it",
    );
    equal(remote.plugin_artifact.sha256, plan.artifact_sha256, "published plugin checksum; bump the version");
    equal(
      JSON.stringify(remote.extension.files),
      JSON.stringify(manifest.extension.files),
      "published extension resources; bump the version",
    );
    // Documentation-only distribution commits do not move an already published tag.
    await verifyTag(sha(remote.distribution_commit), true);
    return { published: false, skipped: true, tag: plan.tag };
  }
  const publishedVersions = releases.filter(
    (item) => !item.isDraft && !item.isPrerelease && /^v\d+\.\d+\.\d+$/.test(item.tagName),
  );
  if (publishedVersions.some((item) => compareVersions(item.tagName.slice(1), plan.version) > 0))
    throw new Error("A newer version was published during the build. Refusing to move Latest backwards.");
  const previousTag =
    publishedVersions
      .filter((item) => compareVersions(item.tagName.slice(1), plan.version) < 0)
      .sort((a, b) => compareVersions(b.tagName.slice(1), a.tagName.slice(1)))[0]?.tagName ?? null;
  equal(
    previousTag,
    plan.previous_release_tag ?? null,
    "changelog baseline changed during the build; rerun the workflow",
  );
  await verifyTag(plan.distribution_commit);
  if (existing) {
    const remote = JSON.parse(
      await run("gh", ["release", "view", plan.tag, "--repo", repository, "--json", "body,targetCommitish"]),
    );
    if (!remote.body.includes(plan.marker))
      throw new Error("Existing draft belongs to a different candidate. Inspect it before retrying.");
    equal(remote.targetCommitish, plan.distribution_commit, "draft target");
  } else {
    await run("gh", [
      "release",
      "create",
      plan.tag,
      "--repo",
      repository,
      "--draft",
      "--target",
      plan.distribution_commit,
      "--title",
      `cdpHelper ${plan.version}`,
      "--notes-file",
      path.join(bundle, "release-notes.md"),
    ]);
  }
  await run("gh", [
    "release",
    "upload",
    plan.tag,
    "--repo",
    repository,
    "--clobber",
    ...expectedFiles.map((file) => path.join(assets, file)),
  ]);
  await run("gh", [
    "release",
    "edit",
    plan.tag,
    "--repo",
    repository,
    "--draft=false",
    "--latest",
    "--target",
    plan.distribution_commit,
    "--notes-file",
    path.join(bundle, "release-notes.md"),
  ]);
  return { published: true, skipped: false, tag: plan.tag };
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      tooling: { type: "string" },
      source: { type: "string" },
      distribution: { type: "string" },
      output: { type: "string" },
      bundle: { type: "string" },
      github: { type: "boolean" },
    },
  });
  let result;
  if (operation === "gitlink") result = { distribution_commit: distributionGitlink(values.tooling) };
  else if (operation === "metadata") result = await releaseMetadata(values);
  else if (operation === "prepare") {
    const metadata = await releaseMetadata(values);
    result = await prepareRelease({
      ...values,
      previousManifest: values.github ? await previousRelease(metadata.version) : null,
    });
  } else if (operation === "publish") {
    if (!process.env.GH_TOKEN)
      throw new Error("Set the CDPHELPER_RELEASE_TOKEN Actions secret (Contents read/write on cdpHelper).");
    result = await publishRelease(values);
  } else throw new Error("Choose gitlink, metadata, prepare or publish.");
  if (process.env.GITHUB_OUTPUT) {
    for (const key of ["version", "tag", "source_commit", "distribution_commit"])
      if (result[key]) await fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`Extension release: ${error.message}`);
    process.exitCode = 1;
  });

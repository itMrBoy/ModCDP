import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const managed = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "plugins/cdphelper"];
const distributionURL = "https://github.com/itMrBoy/cdpHelper.git";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
}
function inside(root, relative) {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid delivery path: ${relative}`);
  const file = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !file.startsWith(path.resolve(root) + path.sep))
    throw new Error(`Delivery path escapes its root: ${relative}`);
  return file;
}
async function exists(file, io = fs) {
  try {
    return await io.lstat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
async function noLinks(root, relative, io = fs) {
  if ((await io.lstat(root)).isSymbolicLink()) throw new Error(`Linked delivery root: ${root}`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await exists(current, io))?.isSymbolicLink()) throw new Error(`Linked delivery path: ${current}`);
  }
}
async function inventory(directory, prefix = "", io = fs) {
  const files = {};
  for (const entry of (await io.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(file, relative + "/", io));
    else if (entry.isFile()) files[relative] = hash(await io.readFile(file));
    else throw new Error(`Nonportable delivery entry: ${file}`);
  }
  return files;
}
async function managedInventory(directory, io = fs) {
  const files = {};
  for (const entry of managed) {
    await noLinks(directory, entry, io);
    const file = inside(directory, entry);
    const existing = await exists(file, io);
    if (existing?.isDirectory()) Object.assign(files, await inventory(file, entry + "/", io));
    else if (existing?.isFile()) files[entry] = hash(await io.readFile(file));
  }
  return files;
}
function same(actual, expected, label) {
  if (actual !== expected) throw new Error(`Invalid ${label}: expected ${expected}, received ${actual}`);
}
function sameInventory(actual, expected, label) {
  same(Object.keys(actual).length, Object.keys(expected).length, `${label} file count`);
  for (const [file, digest] of Object.entries(expected)) same(actual[file], digest, `${label} checksum ${file}`);
}
function forbidden(file) {
  return (
    file.split("/").some((part) => ["node_modules", "extension", "runtime", "source"].includes(part)) ||
    /(?:\.zip$|(?:^|\/)manifest\.json$|(?:^|\/)bridge-config\.json$)/i.test(file)
  );
}

// Validate both outer files and the offline dependency payload before touching the submodule.
export async function validateMarketplace({ root, sourceCommit }) {
  const source = path.join(root, "dist/plugin-marketplace");
  const plugin = path.join(source, "plugins/cdphelper");
  const files = await inventory(source);
  for (const file of Object.keys(files)) {
    if (!managed.some((entry) => file === entry || file.startsWith(entry + "/")) || forbidden(file))
      throw new Error(`Unexpected marketplace file: ${file}`);
  }
  const artifact = await json(path.join(plugin, "artifact.json"));
  const { version } = await json(path.join(root, "plugin/version.json"));
  same(artifact.version, version, "plugin version");
  same(artifact.source_commit, sourceCommit, "artifact source commit");
  same(artifact.source_dirty, false, "artifact clean source");
  const outer = await inventory(plugin);
  delete outer["artifact.json"];
  sameInventory(outer, artifact.files, "plugin");
  const packed = JSON.parse(
    gunzipSync(await fs.readFile(path.join(plugin, "runtime.pack.gz")), {
      maxOutputLength: 256 * 1024 * 1024,
    }).toString("utf8"),
  );
  const runtime = {};
  for (const [file, value] of Object.entries(packed)) {
    inside(plugin, file);
    if (typeof value !== "string" || /\.(?:map|tsx?|zip)$/.test(file) || file.split("/").includes("extension"))
      throw new Error(`Invalid packed runtime file: ${file}`);
    runtime[file] = hash(Buffer.from(value, "base64"));
    const mode = artifact.runtime_modes?.[file];
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`Invalid runtime mode: ${file}`);
  }
  sameInventory(runtime, artifact.runtime_files, "runtime");
  const metadata = JSON.parse(Buffer.from(packed["build.json"], "base64").toString("utf8"));
  same(metadata.source_commit, sourceCommit, "runtime source commit");
  same(metadata.source_dirty, false, "runtime clean source");
  same(metadata.version, version, "runtime version");
  same(metadata.extension_version, version, "extension version");
  same(metadata.protocol_version, 2, "bridge protocol");
  same(metadata.digest, artifact.digest, "runtime digest");
  const { digest, ...buildMetadata } = metadata;
  const digestFiles = { ...runtime };
  delete digestFiles["build.json"];
  same(hash(JSON.stringify({ files: digestFiles, metadata: buildMetadata })), digest, "runtime content digest");
  const codex = await json(path.join(source, managed[0]));
  const claude = await json(path.join(source, managed[1]));
  for (const marketplace of [codex, claude]) {
    same(marketplace.name, "cdphelper-plugins", "marketplace name");
    same(marketplace.plugins.length, 1, "marketplace plugin count");
    same(marketplace.plugins[0].name, "cdphelper", "marketplace plugin name");
  }
  same(codex.plugins[0].source.path, "./plugins/cdphelper", "Codex marketplace path");
  same(claude.plugins[0].source, "./plugins/cdphelper", "Claude marketplace path");
  same(claude.plugins[0].version, version, "marketplace version");
  for (const file of ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const manifest = await json(path.join(plugin, file));
    same(manifest.name, "cdphelper", `${file} name`);
    same(manifest.version, version, `${file} version`);
  }
  for (const file of ["mcp.json", "mcp.codex.json", ".mcp.json"])
    same(Object.keys((await json(path.join(plugin, file))).mcpServers).join(), "cdphelper", `${file} server`);
  for (const file of [
    "skills/cdphelper/SKILL.md",
    "skills/cdphelper/agents/openai.yaml",
    "skills/cdphelper/references/setup.md",
  ])
    if (!outer[file]) throw new Error(`Missing delivered skill file: ${file}`);
  const releases = path.join(root, "dist/releases");
  const release = await json(path.join(releases, "release-manifest.json"));
  same(release.source_commit, sourceCommit, "release source commit");
  same(release.source_dirty, false, "release clean source");
  same(release.plugin_version, version, "release version");
  same(release.extension_version, version, "release extension version");
  same(release.protocol_version, metadata.protocol_version, "release protocol");
  const marketplaceDigest = hash(JSON.stringify(files));
  same(release.marketplace_inventory_sha256, marketplaceDigest, "marketplace digest");
  same(release.plugin_artifact.sha256, files["plugins/cdphelper/artifact.json"], "release artifact checksum");
  same(release.plugin_artifact.digest, artifact.digest, "release runtime digest");
  same(release.extension.filename, `cdphelper-extension-v${version}.zip`, "extension filename");
  const extensionHash = hash(await fs.readFile(path.join(releases, release.extension.filename)));
  same(release.extension.sha256, extensionHash, "extension checksum");
  const checksums = (await fs.readFile(path.join(releases, "SHA256SUMS"), "utf8")).trim().split(/\r?\n/);
  same(
    checksums.join("\n"),
    `${extensionHash}  ${release.extension.filename}\n${hash(await fs.readFile(path.join(releases, "release-manifest.json")))}  release-manifest.json`,
    "release checksums",
  );
  return {
    version,
    source_commit: sourceCommit,
    marketplace_inventory_sha256: marketplaceDigest,
    artifact_sha256: files["plugins/cdphelper/artifact.json"],
    runtime_digest: artifact.digest,
    extension_sha256: extensionHash,
    files,
  };
}

// Replaces only generated entries. Backups live in Git metadata, never in the install tree.
export async function replaceManagedEntries({ source, target }, io = fs) {
  source = path.resolve(source);
  target = path.resolve(target);
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep))
    throw new Error("Delivery source and target must be separate directories.");
  for (const entry of managed) {
    await noLinks(source, entry, io);
    await noLinks(target, entry, io);
    const from = inside(source, entry);
    if (!(await io.lstat(from)).isFile() && entry !== "plugins/cdphelper")
      throw new Error(`Expected generated file: ${entry}`);
    if (entry === "plugins/cdphelper") await inventory(from, "", io);
    const previous = await exists(inside(target, entry), io);
    if (previous && entry === "plugins/cdphelper") await inventory(inside(target, entry), "", io);
  }
  const expected = await managedInventory(source, io);
  const gitDirectory = git(target, "rev-parse", "--absolute-git-dir");
  const transaction = await io.mkdtemp(path.join(gitDirectory, "cdphelper-delivery-"));
  const changes = [];
  let keepBackup = false;
  try {
    for (const [index, entry] of managed.entries()) {
      const prepared = path.join(transaction, `new-${index}`);
      await io.cp(inside(source, entry), prepared, { recursive: true, dereference: false });
      changes.push({
        destination: inside(target, entry),
        prepared,
        backup: path.join(transaction, `old-${index}`),
        original: false,
        installed: false,
      });
    }
    for (const change of changes) {
      await io.mkdir(path.dirname(change.destination), { recursive: true });
      if (await exists(change.destination, io)) {
        await io.rename(change.destination, change.backup);
        change.original = true;
      }
      await io.rename(change.prepared, change.destination);
      change.installed = true;
    }
    sameInventory(await managedInventory(target, io), expected, "delivered marketplace");
  } catch (error) {
    const failures = [];
    for (const change of changes.toReversed()) {
      try {
        if (change.installed) await io.rm(change.destination, { recursive: true, force: true });
        if (change.original) await io.rename(change.backup, change.destination);
      } catch (rollbackError) {
        failures.push(rollbackError.message);
      }
    }
    if (failures.length) {
      keepBackup = true;
      throw new Error(
        `${error.message}; rollback incomplete: ${failures.join("; ")}. Backups retained at ${transaction}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!keepBackup) await io.rm(transaction, { recursive: true, force: true });
  }
}

async function preflight(root) {
  root = await fs.realpath(root);
  same(await fs.realpath(git(root, "rev-parse", "--show-toplevel")), root, "source repository root");
  const sourceCommit = git(root, "rev-parse", "HEAD");
  if (git(root, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"))
    throw new Error("Source checkout must be clean before delivery.");
  same(git(root, "config", "-f", ".gitmodules", "--get", "submodule.cdpHelper.path"), "cdpHelper", "submodule path");
  same(git(root, "config", "-f", ".gitmodules", "--get", "submodule.cdpHelper.url"), distributionURL, "submodule URL");
  const target = path.join(root, "cdpHelper");
  await noLinks(root, "cdpHelper");
  if (!(await exists(path.join(target, ".git"))))
    throw new Error("Initialize the cdpHelper submodule before delivery.");
  same(await fs.realpath(git(target, "rev-parse", "--show-toplevel")), target, "distribution repository root");
  const match = /^160000 ([a-f0-9]{40}) 0\tcdpHelper$/.exec(git(root, "ls-files", "--stage", "--", "cdpHelper"));
  if (!match) throw new Error("cdpHelper must be a tracked submodule.");
  const distributionCommit = git(target, "rev-parse", "HEAD");
  same(distributionCommit, match[1], "submodule HEAD and gitlink");
  same(git(target, "remote", "get-url", "origin"), distributionURL, "distribution origin");
  if (git(target, "status", "--porcelain", "--untracked-files=all"))
    throw new Error("Distribution checkout must be clean before delivery.");
  if (git(target, "ls-files", "--others", "--ignored", "--exclude-standard", "--", ...managed))
    throw new Error("Managed distribution paths contain ignored local files. Preserve them before delivery.");
  return { root, target, sourceCommit, distributionCommit };
}

export async function deliverPlugin({ root, build }) {
  const before = await preflight(root);
  const lock = path.join(git(before.target, "rev-parse", "--absolute-git-dir"), "cdphelper-delivery.lock");
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Delivery already running, or interrupted. Inspect before removing lock: ${lock}`);
    throw error;
  }
  try {
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, source_commit: before.sourceCommit }),
    );
    if (build) await build();
    else
      execFileSync(process.execPath, ["js/scripts/build-plugin.mjs", "--release"], {
        cwd: before.root,
        stdio: "inherit",
        windowsHide: true,
      });
    const candidate = await validateMarketplace({ root: before.root, sourceCommit: before.sourceCommit });
    const after = await preflight(before.root);
    same(after.sourceCommit, before.sourceCommit, "source HEAD after build");
    same(after.distributionCommit, before.distributionCommit, "distribution HEAD after build");
    const oldFiles = {};
    for (const entry of managed) {
      const file = path.join(before.target, entry);
      await noLinks(before.target, entry);
      const existing = await exists(file);
      if (existing?.isDirectory()) Object.assign(oldFiles, await inventory(file, entry + "/"));
      else if (existing?.isFile()) oldFiles[entry] = hash(await fs.readFile(file));
    }
    const differences = [...new Set([...Object.keys(oldFiles), ...Object.keys(candidate.files)])]
      .sort()
      .filter((file) => oldFiles[file] !== candidate.files[file])
      .map((file) => ({
        path: file,
        change: !(file in candidate.files) ? "deleted" : !(file in oldFiles) ? "added" : "modified",
      }));
    await replaceManagedEntries({ source: path.join(before.root, "dist/plugin-marketplace"), target: before.target });
    const { files, ...metadata } = candidate;
    const report = {
      ...metadata,
      distribution_previous_commit: before.distributionCommit,
      target: before.target,
      file_count: Object.keys(files).length,
      differences,
      committed: false,
      pushed: false,
    };
    await fs.writeFile(
      path.join(before.root, "dist/plugin-delivery-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deliverPlugin({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`cdpHelper delivery: ${error.message}`);
      process.exitCode = 1;
    });
}

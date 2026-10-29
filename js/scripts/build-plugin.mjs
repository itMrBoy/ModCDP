import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const root = process.cwd();
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { release: { type: "boolean", default: false } },
});
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceDirty = Boolean(
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim(),
);
if (values.release && sourceDirty)
  throw new Error("Release build requires a clean source checkout. Commit the source changes first.");
const distRoot = path.resolve(root, "dist");
const removeDist = async (target, options = {}) => {
  const relative = path.relative(distRoot, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove outside a dist child: ${target}`);
  }
  await fs.rm(target, { force: true, ...options });
};
const output = path.join(root, "dist/plugin-marketplace");
const releases = path.join(root, "dist/releases");
const plugin = path.join(output, "plugins/cdphelper");
const runtime = path.join(plugin, "runtime");
const { version } = JSON.parse(await fs.readFile(path.join(root, "plugin/version.json"), "utf8"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const writeJSON = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
await removeDist(output, { recursive: true });
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
await fs.mkdir(path.join(output, ".agents/plugins"), { recursive: true });
await fs.mkdir(path.join(output, ".claude-plugin"), { recursive: true });
execFileSync(process.execPath, ["js/scripts/build-extension-assets.mjs", "--cdphelper-plugin", "--no-sourcemap"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
await fs.cp(path.join(root, "skills/cdphelper"), path.join(plugin, "skills/cdphelper"), {
  recursive: true,
  filter: (file) => !file.split(path.sep).join("/").endsWith("scripts/run.mjs"),
});
await fs.copyFile(path.join(root, "plugin/launch.mjs"), path.join(plugin, "launch.mjs"));
await build({
  entryPoints: ["plugin/src/cli.mjs"],
  outfile: path.join(runtime, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
  logLevel: "silent",
});

// Materialize the exact runtime dependency closure; no pnpm symlinks or install scripts reach clients.
const packages = new Map();
const processing = new Set();
async function resolveManifest(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name, "package.json");
    try {
      if (JSON.parse(await fs.readFile(candidate, "utf8")).name === name) return candidate;
    } catch {}
  }
  throw new Error(`Cannot locate runtime dependency manifest for ${name}`);
}
async function copyPackage(name, from) {
  const sourceManifest = await resolveManifest(name, from);
  const source = await fs.realpath(path.dirname(sourceManifest));
  const manifest = JSON.parse(await fs.readFile(sourceManifest, "utf8"));
  const global = packages.get(name);
  const destination =
    global && global.version !== manifest.version
      ? path.join(from === root ? runtime : from, "node_modules", name)
      : path.join(runtime, "node_modules", name);
  if (processing.has(destination)) return;
  processing.add(destination);
  if (!global) packages.set(name, { version: manifest.version, source, destination });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const relative = path.relative(source, file);
      const pieces = relative.split(path.sep);
      return (
        !pieces.some((p) => ["node_modules", "test", "tests", "__tests__", ".github"].includes(p)) &&
        !/\.(?:map|tsx?)$/.test(file)
      );
    },
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    // Resolve from the package's original location, preserving pnpm's exact versions.
    await copyResolved(dependency, source, destination);
  }
}
async function copyResolved(name, sourceParent, destinationParent) {
  const manifestPath = await resolveManifest(name, sourceParent);
  const source = await fs.realpath(path.dirname(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const global = packages.get(name);
  if (global?.version === manifest.version) return;
  const destination = global
    ? path.join(destinationParent, "node_modules", name)
    : path.join(runtime, "node_modules", name);
  if (processing.has(destination)) return;
  processing.add(destination);
  if (!global) packages.set(name, { version: manifest.version, source, destination });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const pieces = path.relative(source, file).split(path.sep);
      return (
        !pieces.some((p) => ["node_modules", "test", "tests", "__tests__", ".github"].includes(p)) &&
        !/\.(?:map|tsx?)$/.test(file)
      );
    },
  });
  for (const child of Object.keys(manifest.dependencies ?? {}).sort()) await copyResolved(child, source, destination);
}
for (const name of ["playwright-core", "@modelcontextprotocol/sdk", "ws", "zod"]) await copyPackage(name, root);
await writeJSON(path.join(runtime, "package.json"), {
  private: true,
  type: "module",
  name: "cdphelper-runtime",
  version,
});
const manifest = {
  name: "cdphelper",
  displayName: "cdpHelper",
  version,
  description: "Operate browsers with Playwright through a local MCP service.",
  author: { name: "itMrBoy" },
  homepage: "https://github.com/itMrBoy/cdpHelper/tree/main",
  repository: "https://github.com/itMrBoy/cdpHelper",
};
await writeJSON(path.join(plugin, "plugin.json"), {
  ...manifest,
  extensions: { "com.openai": { requires_local_executor: true, skills: "./skills/", mcpServers: "./mcp.codex.json" } },
});
await writeJSON(path.join(plugin, ".codex-plugin/plugin.json"), {
  ...manifest,
  skills: "./skills/",
  mcpServers: "./mcp.codex.json",
});
await writeJSON(path.join(plugin, ".claude-plugin/plugin.json"), manifest);
for (const [file, variable] of [
  ["mcp.json", "PLUGIN_ROOT"],
  ["mcp.codex.json", "CLAUDE_PLUGIN_ROOT"],
  [".mcp.json", "CLAUDE_PLUGIN_ROOT"],
]) {
  await writeJSON(path.join(plugin, file), {
    ...(file === "mcp.json" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" } : {}),
    mcpServers: {
      cdphelper: {
        type: "stdio",
        command: "node",
        ...(file === ".mcp.json" ? { args: [`\${${variable}}/launch.mjs`] } : { args: ["launch.mjs"], cwd: "." }),
      },
    },
  });
}
await writeJSON(path.join(output, ".agents/plugins/marketplace.json"), {
  name: "cdphelper-plugins",
  description: "cdpHelper browser automation plugin marketplace",
  plugins: [
    {
      name: "cdphelper",
      source: { source: "local", path: "./plugins/cdphelper" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    },
  ],
});
await writeJSON(path.join(output, ".claude-plugin/marketplace.json"), {
  name: "cdphelper-plugins",
  description: "cdpHelper browser automation plugin marketplace",
  owner: { name: "itMrBoy" },
  plugins: [{ name: "cdphelper", source: "./plugins/cdphelper", version }],
});
const dependencies = [...packages].map(([name, data]) => ({ name, version: data.version }));
await fs.writeFile(
  path.join(plugin, "THIRD_PARTY_NOTICES.md"),
  "# Third-party components\n\nModCDP-derived code: https://github.com/browserbase/ModCDP. No upstream license was found; external distribution requires authorization.\n\nDependency copyright/license files are preserved beside each dependency.\n\n" +
    dependencies.map((p) => `- ${p.name}@${p.version}`).join("\n") +
    "\n",
);
async function inventory(directory, prefix = "") {
  const result = {};
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(file, relative + "/"));
    else if (entry.isFile()) result[relative] = hash(await fs.readFile(file));
    else throw new Error(`Nonportable artifact entry: ${file}`);
  }
  return result;
}
const extensionManifest = JSON.parse(await fs.readFile(path.join(root, "dist/extension/manifest.json"), "utf8"));
const expectedExtensionId = createHash("sha256")
  .update(Buffer.from(extensionManifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
const buildMetadata = {
  version,
  source_commit: commit,
  source_dirty: sourceDirty,
  protocol_version: 2,
  bridge_port: 29393,
  extension_version: version,
  expected_extension_id: expectedExtensionId,
  release_url: `https://github.com/itMrBoy/cdpHelper/releases/tag/v${version}`,
  extension_download_url: `https://github.com/itMrBoy/cdpHelper/releases/download/v${version}/cdphelper-extension-v${version}.zip`,
  dependencies,
};
const runtimeDigest = hash(JSON.stringify({ files: await inventory(runtime), metadata: buildMetadata }));
await writeJSON(path.join(runtime, "build.json"), { ...buildMetadata, digest: runtimeDigest });
const runtimeFiles = await inventory(runtime);
const payload = {};
const runtimeModes = {};
for (const file of Object.keys(runtimeFiles)) {
  payload[file] = (await fs.readFile(path.join(runtime, file))).toString("base64");
  runtimeModes[file] = (await fs.stat(path.join(runtime, file))).mode & 0o777;
}
await fs.writeFile(path.join(plugin, "runtime.pack.gz"), gzipSync(JSON.stringify(payload), { level: 9 }));
await removeDist(runtime, { recursive: true });
const files = await inventory(plugin);
await writeJSON(path.join(plugin, "artifact.json"), {
  version,
  digest: runtimeDigest,
  source_commit: commit,
  source_dirty: sourceDirty,
  runtime_files: runtimeFiles,
  runtime_modes: runtimeModes,
  files,
});

// Extension delivery is a separate Release attachment, never part of the installed plugin.
const stage = path.join(releases, ".extension-stage");
await removeDist(stage, { recursive: true });
await fs.mkdir(stage, { recursive: true });
await fs.cp(path.join(root, "dist/extension"), path.join(stage, "extension"), { recursive: true });
for (const file of ["README.md", "README.zh-CN.md"])
  await fs.copyFile(path.join(root, "plugin/release", file), path.join(stage, file));
await fs.cp(path.join(root, "dist/extension-notices/LICENSES"), path.join(stage, "LICENSES"), { recursive: true });
await fs.copyFile(
  path.join(root, "dist/extension-notices/THIRD_PARTY_NOTICES.md"),
  path.join(stage, "THIRD_PARTY_NOTICES.md"),
);
const zipName = `cdphelper-extension-v${version}.zip`;
const zipFile = path.join(releases, zipName);
await removeDist(zipFile);
try {
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath 'README.md','README.zh-CN.md','THIRD_PARTY_NOTICES.md','LICENSES','extension' -DestinationPath $env:CDPHELPER_EXTENSION_ARCHIVE -CompressionLevel Optimal",
      ],
      {
        cwd: stage,
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, CDPHELPER_EXTENSION_ARCHIVE: zipFile },
      },
    );
  } else {
    execFileSync(
      "zip",
      ["-X", "-qr", zipFile, "README.md", "README.zh-CN.md", "THIRD_PARTY_NOTICES.md", "LICENSES", "extension"],
      {
        cwd: stage,
        stdio: "inherit",
      },
    );
  }
} finally {
  await removeDist(stage, { recursive: true });
}
const zipHash = hash(await fs.readFile(zipFile));
const artifactFile = path.join(plugin, "artifact.json");
await writeJSON(path.join(releases, "release-manifest.json"), {
  plugin_version: version,
  extension_version: version,
  protocol_version: 2,
  source_repository_url: "https://github.com/itMrBoy/ModCDP.git",
  source_commit: commit,
  source_dirty: sourceDirty,
  release_tag: `v${version}`,
  distribution_repository_url: "https://github.com/itMrBoy/cdpHelper",
  marketplace_directory: "../plugin-marketplace",
  marketplace_inventory_sha256: hash(JSON.stringify(await inventory(output))),
  plugin_artifact: {
    path: "../plugin-marketplace/plugins/cdphelper/artifact.json",
    sha256: hash(await fs.readFile(artifactFile)),
    digest: runtimeDigest,
  },
  extension: {
    filename: zipName,
    sha256: zipHash,
    expected_extension_id: expectedExtensionId,
    files: await inventory(path.join(root, "dist/extension")),
  },
});
await fs.writeFile(
  path.join(releases, "SHA256SUMS"),
  `${zipHash}  ${zipName}\n${hash(await fs.readFile(path.join(releases, "release-manifest.json")))}  release-manifest.json\n`,
);
console.log(
  `Built ${plugin} and ${zipFile} (${version}, ${Object.keys(files).length} plugin files, source_dirty=${sourceDirty}). No npm or marketplace publication was performed.`,
);

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    "enable-reversews": { type: "boolean", default: false },
    "enable-nats": { type: "boolean", default: false },
    "no-sourcemap": { type: "boolean", default: false },
    "cdphelper-plugin": { type: "boolean", default: false },
  },
});

const root = process.cwd();
const dist_extension = path.join(root, "dist", "extension");
const distRoot = path.resolve(root, "dist");
const removeDist = (target, options = {}) => {
  const relative = path.relative(distRoot, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove outside a dist child: ${target}`);
  }
  fs.rmSync(target, { force: true, ...options });
};

if (fs.existsSync(dist_extension)) {
  for (const entry of fs.readdirSync(dist_extension, { withFileTypes: true })) {
    if (entry.name !== "src") removeDist(path.join(dist_extension, entry.name), { recursive: true });
  }
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
};

copy("extension/manifest.json", "dist/extension/manifest.json");
copy("extension/icons/logo.png", "dist/extension/icons/logo.png");
if (values["cdphelper-plugin"]) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "plugin/version.json"), "utf8"));
  const manifestFile = path.join(dist_extension, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = version;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const source_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(dist_extension, "cdphelper-bridge.json"),
    JSON.stringify(
      {
        protocol_version: 2,
        plugin_version: version,
        extension_version: version,
        source_commit,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  fs.writeFileSync(path.join(dist_extension, "bridge-config.json"), "{}\n");
}
copy("extension/src/pages/options.html", "dist/extension/options.html");
copy("extension/src/pages/offscreen_keepalive.html", "dist/extension/offscreen/keepalive.html");
const bundle = await build({
  entryPoints: {
    "modcdp/service_worker": path.join(root, "extension/src/service_worker.ts"),
    options: path.join(root, "extension/src/pages/options.ts"),
    "offscreen/offscreen_keepalive": path.join(root, "extension/src/pages/offscreen_keepalive.ts"),
  },
  outdir: dist_extension,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  define: {
    __MODCDP_ENABLE_REVERSEWS__: String(values["enable-reversews"] || values["cdphelper-plugin"]),
    __MODCDP_ENABLE_NATS__: String(values["enable-nats"]),
    __CDPHELPER_PLUGIN_BRIDGE__: String(values["cdphelper-plugin"]),
  },
  sourcemap: !values["no-sourcemap"],
  logLevel: "silent",
  metafile: true,
});
// Retain notices for dependencies actually included in the browser bundle.
// Keep them outside extension/ so the independent Release ZIP can put them at its root.
const noticesRoot = path.join(distRoot, "extension-notices");
removeDist(noticesRoot, { recursive: true });
fs.mkdirSync(path.join(noticesRoot, "LICENSES"), { recursive: true });
const bundledPackages = new Map();
for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name && manifest.version) {
        bundledPackages.set(`${manifest.name}@${manifest.version}`, { manifest, directory });
        break;
      }
    } catch {}
    directory = path.dirname(directory);
  }
}
const notices = [
  "# Extension third-party components",
  "",
  "ModCDP-derived code: https://github.com/browserbase/ModCDP. No upstream license was found; external distribution requires authorization. This notice does not grant an upstream license.",
  "",
  "The following dependencies are included in the browser JavaScript bundle. Their original copyright and license text is preserved in LICENSES/.",
  "",
];
const licenseNames = new Set();
for (const [identifier, { manifest, directory }] of [...bundledPackages].sort(([a], [b]) => a.localeCompare(b))) {
  const licenseFiles = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice|copyright)(?:$|[._-])/i.test(entry.name));
  if (!licenseFiles.length) throw new Error(`Missing bundled dependency license: ${identifier}`);
  notices.push(`- ${identifier}: ${manifest.license ?? "see original license text"}`);
  for (const entry of licenseFiles) {
    const prefix = manifest.name.replace(/^@/, "").replaceAll("/", "-");
    let filename = `${prefix}-${entry.name}.txt`;
    if (licenseNames.has(filename)) filename = `${prefix}-${manifest.version}-${entry.name}.txt`;
    licenseNames.add(filename);
    fs.copyFileSync(path.join(directory, entry.name), path.join(noticesRoot, "LICENSES", filename));
  }
}
fs.writeFileSync(path.join(noticesRoot, "THIRD_PARTY_NOTICES.md"), notices.join("\n") + "\n");
removeDist(path.join(dist_extension, "src"), { recursive: true });

const fixed_date = new Date("2000-01-01T00:00:00Z");
const touchTree = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full_path = path.join(dir, entry.name);
    if (entry.isDirectory()) touchTree(full_path);
    fs.utimesSync(full_path, fixed_date, fixed_date);
  }
  fs.utimesSync(dir, fixed_date, fixed_date);
};
touchTree(dist_extension);

removeDist(path.join(root, "dist", "extension.zip"));
const archive_options = { cwd: path.join(root, "dist"), stdio: "inherit" };
if (process.platform === "win32") {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath 'extension' -DestinationPath 'extension.zip' -CompressionLevel Optimal",
    ],
    { ...archive_options, windowsHide: true },
  );
} else {
  execFileSync("zip", ["-X", "-qr", "extension.zip", "extension"], archive_options);
}

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
  },
});

const root = process.cwd();
const dist_extension = path.join(root, "dist", "extension");

if (fs.existsSync(dist_extension)) {
  for (const entry of fs.readdirSync(dist_extension, { withFileTypes: true })) {
    if (entry.name !== "src") fs.rmSync(path.join(dist_extension, entry.name), { recursive: true, force: true });
  }
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
};

copy("extension/manifest.json", "dist/extension/manifest.json");
copy("extension/src/pages/options.html", "dist/extension/options.html");
copy("extension/src/pages/offscreen_keepalive.html", "dist/extension/offscreen/keepalive.html");
await build({
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
    __MODCDP_ENABLE_REVERSEWS__: String(values["enable-reversews"]),
    __MODCDP_ENABLE_NATS__: String(values["enable-nats"]),
  },
  sourcemap: true,
  logLevel: "silent",
});
fs.rmSync(path.join(dist_extension, "src"), { recursive: true, force: true });

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

fs.rmSync(path.join(root, "dist", "extension.zip"), { force: true });
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

copy("dist/extension.zip", "python/modcdp/extension.zip");
copy("dist/extension.zip", "go/modcdp/injector/extension.zip");

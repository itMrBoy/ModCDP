// No application dependencies are imported before the Node compatibility check.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, copyFile, rename, stat } from "node:fs/promises";

async function verify(root, inventory) {
  for (const [relative, expected] of Object.entries(inventory)) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Invalid artifact path");
    const actual = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (actual !== expected) throw new Error(`Plugin artifact checksum mismatch: ${relative}. Reinstall the plugin.`);
  }
}
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(
      `Node >=22 is required; current ${process.version} (${process.execPath}). Select a compatible Node yourself. This plugin does not switch Node or change PATH.`,
    );
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  const inventory = JSON.parse(await readFile(path.join(root, "artifact.json"), "utf8"));
  const homeIndex = process.argv.indexOf("--home");
  const home = path.resolve(homeIndex >= 0 ? process.argv[homeIndex + 1] : path.join(homedir(), ".cdphelper"));
  await verify(root, inventory.files);
  if (process.argv.includes("--check")) {
    process.stdout.write(
      JSON.stringify({ version: inventory.version, valid: true, node: process.version, executable: process.execPath }) +
        "\n",
    );
    return;
  }
  const versions = path.join(home, "runtimes");
  const runtimeFiles = Object.fromEntries(
    Object.entries(inventory.files)
      .filter(([file]) => file.startsWith("runtime/"))
      .map(([file, hash]) => [file.slice(8), hash]),
  );
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const installed = path.join(versions, `${inventory.version}-${inventory.digest.slice(0, 16)}`);
  try {
    await stat(installed);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const staging = path.join(versions, `.staging-${randomUUID()}`);
    const files = Object.keys(runtimeFiles);
    const directories = [...new Set(files.map((file) => path.dirname(path.join(staging, file))))];
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
    // Copy only verified inventory entries, with bounded parallel I/O for Windows cold starts.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, files.length) }, async () => {
        while (next < files.length) {
          const file = files[next++];
          await copyFile(path.join(root, "runtime", file), path.join(staging, file));
        }
      }),
    );
    try {
      await rename(staging, installed);
    } catch (renameError) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(renameError.code)) throw renameError;
      await stat(installed);
    }
  }
  await verify(installed, runtimeFiles);
  await import(pathToFileURL(path.join(installed, "cli.mjs")).href);
}
main().catch((error) => {
  console.error(`cdpHelper: ${error.message}`);
  process.exitCode = 1;
});

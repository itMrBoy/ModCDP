import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { signCrx, verifyCrx } from "./crx3.mjs";
import { readZip, writeZip } from "./extension-zip.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJSON = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`Invalid release ${label}`);
}
const filenames = (version, signed) => [
  `cdphelper-extension-v${version}.zip`,
  ...(signed ? [`cdphelper-extension-v${version}.crx`] : []),
  "release-manifest.json",
  "SHA256SUMS",
];
function checksums(manifest, manifestBytes) {
  return (
    `${manifest.extension.sha256}  ${manifest.extension.filename}\n` +
    (manifest.extension.crx ? `${manifest.extension.crx.sha256}  ${manifest.extension.crx.filename}\n` : "") +
    `${hash(manifestBytes)}  release-manifest.json\n`
  );
}

// Runs before secrets are consumed, and again independently before publication.
export async function verifyReleaseBundle(bundle, { signed = true } = {}) {
  const plan = await json(path.join(bundle, "release-plan.json"));
  if (!/^\d+\.\d+\.\d+$/.test(plan.version)) throw new Error("Invalid release version");
  const assets = path.join(bundle, "assets");
  const names = filenames(plan.version, signed).sort();
  requireEqual(Object.keys(plan.assets).sort().join(), names.join(), "asset inventory");
  const entries = await fs.readdir(assets, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error("Non-file release asset");
  requireEqual(
    entries
      .map((entry) => entry.name)
      .sort()
      .join(),
    names.join(),
    "asset files",
  );
  for (const name of names)
    requireEqual(hash(await fs.readFile(path.join(assets, name))), plan.assets[name], "asset checksum");
  const manifestBytes = await fs.readFile(path.join(assets, "release-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  requireEqual(manifest.source_commit, plan.source_commit, "source commit");
  requireEqual(manifest.distribution_commit, plan.distribution_commit, "distribution commit");
  requireEqual(manifest.plugin_artifact.sha256, plan.artifact_sha256, "plugin artifact");
  requireEqual(manifest.source_dirty, false, "clean source");
  requireEqual(manifest.extension_version, plan.version, "extension version");
  requireEqual(manifest.plugin_version, plan.version, "plugin version");
  requireEqual(manifest.extension.filename, `cdphelper-extension-v${plan.version}.zip`, "ZIP filename");
  const archive = await fs.readFile(path.join(assets, manifest.extension.filename));
  requireEqual(hash(archive), manifest.extension.sha256, "ZIP checksum");
  const extension = new Map(
    [...readZip(archive)]
      .filter(([name]) => name.startsWith("extension/"))
      .map(([name, bytes]) => [name.slice(10), bytes]),
  );
  requireEqual(
    [...extension.keys()].sort().join(),
    Object.keys(manifest.extension.files).sort().join(),
    "extension inventory",
  );
  for (const [name, bytes] of extension)
    requireEqual(hash(bytes), manifest.extension.files[name], "extension file checksum");
  const extensionManifest = JSON.parse(extension.get("manifest.json"));
  requireEqual(extensionManifest.version, plan.version, "manifest version");
  const bridge = JSON.parse(extension.get("cdphelper-bridge.json"));
  requireEqual(bridge.source_commit, plan.source_commit, "bridge source");
  requireEqual(bridge.extension_version, plan.version, "bridge version");
  if (signed) {
    const crx = manifest.extension.crx;
    if (!crx) throw new Error("Missing signed CRX");
    requireEqual(crx.filename, `cdphelper-extension-v${plan.version}.crx`, "CRX filename");
    requireEqual(crx.id, manifest.extension.expected_extension_id, "CRX identity");
    const bytes = await fs.readFile(path.join(assets, crx.filename));
    requireEqual(hash(bytes), crx.sha256, "CRX checksum");
    const verified = verifyCrx(bytes, manifest.extension.expected_extension_id);
    const contents = readZip(verified.zip);
    requireEqual([...contents.keys()].sort().join(), [...extension.keys()].sort().join(), "CRX inventory");
    for (const [name, bytes] of extension)
      if (!bytes.equals(contents.get(name))) throw new Error("CRX payload differs from ZIP");
  } else if (manifest.extension.crx) throw new Error("Unsigned candidate already contains CRX metadata");
  requireEqual(
    (await fs.readFile(path.join(assets, "SHA256SUMS"), "utf8")).replaceAll("\r\n", "\n"),
    checksums(manifest, manifestBytes),
    "checksums",
  );
  requireEqual(hash(await fs.readFile(path.join(bundle, "release-notes.md"))), plan.notes_sha256, "release notes");
  return { plan, manifest, extension };
}

export async function signRelease({ bundle, privateKey }) {
  if (!privateKey) throw new Error("CDPHELPER_EXTENSION_SIGNING_KEY is required");
  const { plan, manifest, extension } = await verifyReleaseBundle(bundle, { signed: false });
  const crx = signCrx(writeZip(extension), privateKey, manifest.extension.expected_extension_id);
  const filename = `cdphelper-extension-v${plan.version}.crx`;
  const assets = path.join(bundle, "assets");
  manifest.extension.crx = { filename, sha256: hash(crx), id: manifest.extension.expected_extension_id };
  await fs.writeFile(path.join(assets, filename), crx);
  await writeJSON(path.join(assets, "release-manifest.json"), manifest);
  await fs.writeFile(
    path.join(assets, "SHA256SUMS"),
    checksums(manifest, await fs.readFile(path.join(assets, "release-manifest.json"))),
  );
  for (const name of filenames(plan.version, true))
    plan.assets[name] = hash(await fs.readFile(path.join(assets, name)));
  await writeJSON(path.join(bundle, "release-plan.json"), plan);
  await verifyReleaseBundle(bundle);
  return { version: plan.version, filename, id: manifest.extension.expected_extension_id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { bundle: { type: "string" }, verify: { type: "boolean" } } });
  const key = process.env.CDPHELPER_EXTENSION_SIGNING_KEY;
  delete process.env.CDPHELPER_EXTENSION_SIGNING_KEY;
  const operation = values.verify
    ? verifyReleaseBundle(values.bundle).then(({ plan }) => ({ verified: plan.version }))
    : signRelease({ bundle: values.bundle, privateKey: key });
  operation
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "CRX release validation/signing failed. Check candidate integrity and the configured signing identity.",
      );
      process.exitCode = 1;
    });
}

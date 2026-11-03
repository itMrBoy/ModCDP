import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { signRelease, verifyReleaseBundle } from "../../js/scripts/sign-extension-release.mjs";
import { extensionId, signCrx } from "../../js/scripts/crx3.mjs";
import { readZip, writeZip } from "../../js/scripts/extension-zip.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
const id = extensionId(publicKey);
const version = "0.2.3",
  source = "a".repeat(40),
  distribution = "b".repeat(40),
  artifact = "c".repeat(64);
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJSON = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

async function snapshot(root) {
  const result = {};
  async function visit(directory, prefix = "") {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + "/");
      else result[name] = hash(await fs.readFile(path.join(directory, entry.name)));
    }
  }
  await visit(root);
  return result;
}

// Refresh the outer envelope to prove checks are not merely trusting plan hashes.
async function refresh(bundle, manifest) {
  const assets = path.join(bundle, "assets");
  await writeJSON(path.join(assets, "release-manifest.json"), manifest);
  let sums = `${manifest.extension.sha256}  ${manifest.extension.filename}\n`;
  if (manifest.extension.crx) sums += `${manifest.extension.crx.sha256}  ${manifest.extension.crx.filename}\n`;
  sums += `${hash(await fs.readFile(path.join(assets, "release-manifest.json")))}  release-manifest.json\n`;
  await fs.writeFile(path.join(assets, "SHA256SUMS"), sums);
  const plan = await json(path.join(bundle, "release-plan.json"));
  plan.assets = {};
  for (const name of await fs.readdir(assets)) plan.assets[name] = hash(await fs.readFile(path.join(assets, name)));
  await writeJSON(path.join(bundle, "release-plan.json"), plan);
}

async function fixture(t) {
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "cdphelper-signing-test-"));
  t.after(() => fs.rm(bundle, { recursive: true, force: true }));
  const assets = path.join(bundle, "assets");
  await fs.mkdir(assets);
  const files = new Map([
    [
      "manifest.json",
      Buffer.from(JSON.stringify({ manifest_version: 3, version, name: "test", key: publicKey.toString("base64") })),
    ],
    [
      "cdphelper-bridge.json",
      Buffer.from(
        JSON.stringify({
          source_commit: source,
          extension_version: version,
          plugin_version: version,
          protocol_version: 2,
        }),
      ),
    ],
    ["worker.js", Buffer.from("console.log('original')")],
  ]);
  const zip = writeZip(
    new Map([
      ["README.md", Buffer.from("release instructions")],
      ...[...files].map(([name, bytes]) => ["extension/" + name, bytes]),
    ]),
  );
  const manifest = {
    plugin_version: version,
    extension_version: version,
    protocol_version: 2,
    source_commit: source,
    distribution_commit: distribution,
    source_dirty: false,
    plugin_artifact: { sha256: artifact },
    extension: {
      filename: `cdphelper-extension-v${version}.zip`,
      sha256: hash(zip),
      expected_extension_id: id,
      files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])),
    },
  };
  await fs.writeFile(path.join(assets, manifest.extension.filename), zip);
  await fs.writeFile(path.join(bundle, "release-notes.md"), "fixture notes\n");
  await writeJSON(path.join(bundle, "release-plan.json"), {
    version,
    source_commit: source,
    distribution_commit: distribution,
    artifact_sha256: artifact,
    notes_sha256: hash("fixture notes\n"),
  });
  await refresh(bundle, manifest);
  return { bundle, assets, files, manifest };
}

test("missing or wrong signing key leaves the unsigned bundle byte-for-byte intact", async (t) => {
  const { bundle } = await fixture(t);
  const before = await snapshot(bundle);
  await assert.rejects(signRelease({ bundle }), /SIGNING_KEY is required/);
  assert.deepEqual(await snapshot(bundle), before);
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  await assert.rejects(signRelease({ bundle, privateKey: otherKey }), /signing key identity mismatch/);
  assert.deepEqual(await snapshot(bundle), before);
});

test("two independent candidates produce identical signed attachments and matching payloads", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const unsigned = await snapshot(first.bundle);
  for (const candidate of [first, second]) {
    await signRelease({ bundle: candidate.bundle, privateKey });
    const verified = await verifyReleaseBundle(candidate.bundle);
    assert.deepEqual(verified.extension, candidate.files);
    assert.equal(verified.manifest.extension.crx.id, id);
  }
  assert.deepEqual(await snapshot(first.bundle), await snapshot(second.bundle));
  assert.equal(
    (await snapshot(first.bundle))[`assets/${first.manifest.extension.filename}`],
    unsigned[`assets/${first.manifest.extension.filename}`],
  );
  const signed = await snapshot(first.bundle);
  await assert.rejects(signRelease({ bundle: first.bundle, privateKey }), /asset inventory/);
  assert.deepEqual(await snapshot(first.bundle), signed, "signed input is not silently overwritten");
});

test("unsigned payload tampering fails despite updated outer checksums", async (t) => {
  const { bundle, assets, manifest } = await fixture(t);
  const filename = path.join(assets, manifest.extension.filename);
  const contents = readZip(await fs.readFile(filename));
  contents.set("extension/worker.js", Buffer.from("tampered"));
  const archive = writeZip(contents);
  await fs.writeFile(filename, archive);
  manifest.extension.sha256 = hash(archive);
  await refresh(bundle, manifest);
  const before = await snapshot(bundle);
  await assert.rejects(signRelease({ bundle, privateKey }), /extension file checksum/);
  assert.deepEqual(await snapshot(bundle), before);
});

test("source provenance mismatch fails even when file inventory and outer hashes agree", async (t) => {
  const { bundle, assets, manifest } = await fixture(t);
  const filename = path.join(assets, manifest.extension.filename);
  const contents = readZip(await fs.readFile(filename));
  const bridge = Buffer.from(JSON.stringify({ source_commit: "d".repeat(40), extension_version: version }));
  contents.set("extension/cdphelper-bridge.json", bridge);
  const archive = writeZip(contents);
  await fs.writeFile(filename, archive);
  manifest.extension.sha256 = hash(archive);
  manifest.extension.files["cdphelper-bridge.json"] = hash(bridge);
  await refresh(bundle, manifest);
  await assert.rejects(signRelease({ bundle, privateKey }), /bridge source/);
});

test("invalid CRX signature fails even when every outer checksum is refreshed", async (t) => {
  const { bundle, assets } = await fixture(t);
  await signRelease({ bundle, privateKey });
  const manifest = await json(path.join(assets, "release-manifest.json"));
  const filename = path.join(assets, manifest.extension.crx.filename);
  const crx = await fs.readFile(filename);
  crx[crx.length - 1] ^= 1;
  await fs.writeFile(filename, crx);
  manifest.extension.crx.sha256 = hash(crx);
  await refresh(bundle, manifest);
  await assert.rejects(verifyReleaseBundle(bundle), /signature verification failed/);
});

test("validly signed CRX with divergent contents is rejected against the release ZIP", async (t) => {
  const { bundle, assets, files } = await fixture(t);
  await signRelease({ bundle, privateKey });
  const manifest = await json(path.join(assets, "release-manifest.json"));
  files.set("worker.js", Buffer.from("different but validly signed"));
  const crx = signCrx(writeZip(files), privateKey, id);
  await fs.writeFile(path.join(assets, manifest.extension.crx.filename), crx);
  manifest.extension.crx.sha256 = hash(crx);
  await refresh(bundle, manifest);
  await assert.rejects(verifyReleaseBundle(bundle), /CRX payload differs from ZIP/);
});

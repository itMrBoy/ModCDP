import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify, constants } from "node:crypto";
import { signCrx, verifyCrx, extensionId } from "../../js/scripts/crx3.mjs";
import { readZip, writeZip } from "../../js/scripts/extension-zip.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const id = extensionId(publicKey);
const files = (version = "0.2.3") =>
  new Map([
    [
      "manifest.json",
      Buffer.from(JSON.stringify({ manifest_version: 3, name: "fixture", version, key: publicKey.toString("base64") })),
    ],
    ["icons/logo.png", Buffer.from([0, 1, 255])],
    ["worker.js", Buffer.from("console.log('fixture');")],
  ]);

test("CRX3 versions retain the signing identity and exact archive bytes", () => {
  for (const version of ["0.2.3", "0.2.4"]) {
    const zip = writeZip(files(version)),
      crx = signCrx(zip, privateKey, id);
    const checked = verifyCrx(crx, id);
    assert.equal(checked.id, id);
    assert.deepEqual(checked.publicKey, publicKey);
    assert.deepEqual(checked.zip, zip);
    assert.deepEqual(readZip(checked.zip), files(version));
    assert.deepEqual(crx, signCrx(zip, privateKey, id), "deterministic signing");
  }
});

test("missing keys, mismatched keys and mismatched manifest identity fail closed", () => {
  const zip = writeZip(files());
  assert.throws(() => signCrx(zip, undefined, id), /key missing/);
  assert.throws(() => signCrx(zip, privateKey), /expected ID required/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => signCrx(zip, other, id), /signing key identity mismatch/);
  const wrongManifest = files();
  wrongManifest.set("manifest.json", Buffer.from('{"key":"other"}'));
  assert.throws(() => signCrx(writeZip(wrongManifest), privateKey, id), /manifest key identity mismatch/);
  assert.throws(
    () => signCrx(writeZip(new Map([["extension/manifest.json", files().get("manifest.json")]])), privateKey, id),
    /archive root/,
  );
});

test("tampered CRX header, proof and payload cannot verify", () => {
  const crx = signCrx(writeZip(files()), privateKey, id);
  for (const offset of [0, 4, 8, 14, 40, crx.length - 1]) {
    const bad = Buffer.from(crx);
    bad[offset] ^= 1;
    assert.throws(() => verifyCrx(bad, id));
  }
  assert.throws(() => verifyCrx(crx, "a".repeat(32)), /identity mismatch/);
  assert.throws(() => verifyCrx(crx.subarray(0, 11), id), /header/);
});

test("signature matches the Chromium CRX3 signed byte layout independently", () => {
  const zip = writeZip(files()),
    crx = signCrx(zip, privateKey, id);
  // Independent wire walk (rather than calling the production decoder).
  let p = 12;
  const integer = () => {
    let n = 0,
      s = 0,
      c;
    do {
      c = crx[p++];
      n |= (c & 127) << s;
      s += 7;
    } while (c & 128);
    return n;
  };
  assert.equal(integer(), 18);
  integer();
  assert.equal(integer(), 10);
  const keyLength = integer();
  p += keyLength;
  assert.equal(integer(), 18);
  const signatureLength = integer();
  const signature = crx.subarray(p, p + signatureLength);
  p += signatureLength;
  assert.equal(integer(), 80002);
  const signedLength = integer(),
    signed = crx.subarray(p, p + signedLength);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedLength);
  assert.equal(
    verify(
      "sha256",
      Buffer.concat([Buffer.from("CRX3 SignedData\0"), length, signed, zip]),
      { key: createPublicKey(privateKey), padding: constants.RSA_PKCS1_PADDING },
      signature,
    ),
    true,
  );
});

test("ZIP reader rejects corruption, traversal, duplicate names and file conflicts", () => {
  const zip = writeZip(files());
  const bad = Buffer.from(zip);
  bad[14] ^= 1;
  assert.throws(() => readZip(bad), /CRC mismatch/);
  for (const name of ["../secret", "/absolute", "C:/secret", "foo\\bar", "./file", "a//b"]) {
    assert.throws(() => writeZip(new Map([[name, Buffer.from("x")]])), /unsafe path/);
  }
  assert.throws(
    () =>
      writeZip(
        new Map([
          ["a", Buffer.from("x")],
          ["A", Buffer.from("y")],
        ]),
      ),
    /duplicate path/,
  );
  assert.throws(
    () =>
      writeZip(
        new Map([
          ["a", Buffer.from("x")],
          ["a/b", Buffer.from("y")],
        ]),
      ),
    /file\/directory conflict/,
  );
  assert.throws(() => readZip(zip.subarray(0, zip.length - 1)), /end record/);
});

test("ZIP writer is deterministic regardless of insertion order", () => {
  assert.deepEqual(writeZip(files()), writeZip(new Map([...files()].reverse())));
});

import { constants, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readZip } from "./extension-zip.mjs";

const context = Buffer.from("CRX3 SignedData\0");
function check(condition, message) {
  if (!condition) throw new Error(`Invalid CRX3: ${message}`);
}
export function extensionId(publicKeyDer) {
  return createHash("sha256")
    .update(publicKeyDer)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
}
function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function varint(n) {
  const out = [];
  do {
    const part = n & 127;
    n = Math.floor(n / 128);
    out.push(part | (n ? 128 : 0));
  } while (n);
  return Buffer.from(out);
}
function field(number, data) {
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}
function fields(b) {
  let p = 0;
  const result = new Map();
  function number() {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 5; i++) {
      check(p < b.length, "truncated protobuf");
      const byte = b[p++];
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new Error("Invalid CRX3: oversized protobuf integer");
  }
  while (p < b.length) {
    const tag = number(),
      size = number(),
      key = tag >>> 3;
    check(
      (tag & 7) === 2 && key > 0 && p + size <= b.length && !result.has(key),
      "unsupported or duplicate protobuf field",
    );
    result.set(key, b.subarray(p, p + size));
    p += size;
  }
  return result;
}
function validateArchive(zip, expectedId) {
  check(typeof expectedId === "string" && /^[a-p]{32}$/.test(expectedId), "expected ID required");
  const files = readZip(zip);
  check(files.has("manifest.json"), "manifest must be at archive root");
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  check(
    typeof manifest.key === "string" && extensionId(Buffer.from(manifest.key, "base64")) === expectedId,
    "manifest key identity mismatch",
  );
}

export function signCrx(zipBytes, privateKeyPem, expectedId) {
  check(privateKeyPem && privateKeyPem.length, "signing key missing");
  const zip = Buffer.from(zipBytes);
  validateArchive(zip, expectedId);
  const key = createPrivateKey(privateKeyPem);
  check(
    key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength >= 2048,
    "RSA key of at least 2048 bits required",
  );
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  check(extensionId(publicKey) === expectedId, "signing key identity mismatch");
  const signedHeader = field(1, createHash("sha256").update(publicKey).digest().subarray(0, 16));
  const message = Buffer.concat([context, uint32(signedHeader.length), signedHeader, zip]);
  const signature = sign("sha256", message, { key, padding: constants.RSA_PKCS1_PADDING });
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicKey), field(2, signature)])),
    field(10000, signedHeader),
  ]);
  const crx = Buffer.concat([Buffer.from("Cr24"), uint32(3), uint32(header.length), header, zip]);
  verifyCrx(crx, expectedId);
  return crx;
}

export function verifyCrx(input, expectedId) {
  const crx = Buffer.from(input);
  check(crx.length >= 12 && crx.subarray(0, 4).equals(Buffer.from("Cr24")) && crx.readUInt32LE(4) === 3, "header");
  const size = crx.readUInt32LE(8);
  check(size > 0 && size <= 1024 * 1024 && 12 + size < crx.length, "header size");
  const header = fields(crx.subarray(12, 12 + size));
  check(header.size === 2 && header.has(2) && header.has(10000), "RSA proof and signed header required");
  const proof = fields(header.get(2)),
    signedHeader = header.get(10000),
    data = fields(signedHeader);
  check(
    proof.size === 2 && proof.has(1) && proof.has(2) && data.size === 1 && data.get(1)?.length === 16,
    "proof fields",
  );
  const publicKey = proof.get(1),
    id = extensionId(publicKey);
  check(
    id === expectedId && data.get(1).equals(createHash("sha256").update(publicKey).digest().subarray(0, 16)),
    "signed identity mismatch",
  );
  const zip = crx.subarray(12 + size),
    key = createPublicKey({ key: publicKey, type: "spki", format: "der" });
  check(key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength >= 2048, "RSA signing key required");
  check(
    verify(
      "sha256",
      Buffer.concat([context, uint32(signedHeader.length), signedHeader, zip]),
      { key, padding: constants.RSA_PKCS1_PADDING },
      proof.get(2),
    ),
    "signature verification failed",
  );
  validateArchive(zip, expectedId);
  return { zip, id, publicKey };
}

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LIMIT = 64 * 1024 * 1024;
const table = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function check(condition, message) {
  if (!condition) throw new Error(`Invalid extension ZIP: ${message}`);
}
function nameOf(bytes) {
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parts = name.replace(/\/$/, "").split("/");
  check(
    name &&
      !/[\\:]/.test(name) &&
      ![...name].some((c) => c.charCodeAt(0) < 32) &&
      parts.every((p) => p && p !== "." && p !== ".."),
    "unsafe path",
  );
  return name;
}

// Bounded classic ZIP reader for release artifacts: stored/deflate, no ZIP64,
// encryption or links. Central-directory sizes also support data descriptors.
export function readZip(input) {
  const b = Buffer.from(input);
  check(b.length >= 22 && b.length <= LIMIT, "archive size");
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (b.readUInt32LE(p) === 0x06054b50 && p + 22 + b.readUInt16LE(p + 20) === b.length) {
      end = p;
      break;
    }
  }
  check(end >= 0, "missing end record");
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  check(!b.readUInt16LE(end + 4) && !b.readUInt16LE(end + 6) && b.readUInt16LE(end + 8) === count, "split archive");
  check(count < 65535 && start + size === end, "central directory bounds or ZIP64");
  const result = new Map(),
    names = new Set(),
    ranges = [];
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    check(p + 46 <= end && b.readUInt32LE(p) === 0x02014b50, "central entry");
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      crc = b.readUInt32LE(p + 16);
    const packed = b.readUInt32LE(p + 20),
      unpacked = b.readUInt32LE(p + 24);
    const nameLength = b.readUInt16LE(p + 28),
      extraLength = b.readUInt16LE(p + 30),
      commentLength = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42),
      attrs = b.readUInt32LE(p + 38);
    check(!(flags & ~0x080e) && [0, 8].includes(method) && b.readUInt16LE(p + 34) === 0, "unsupported entry");
    check(((attrs >>> 16) & 0xf000) !== 0xa000, "symbolic link");
    check(p + 46 + nameLength + extraLength + commentLength <= end, "entry bounds");
    const nameBytes = b.subarray(p + 46, p + 46 + nameLength),
      name = nameOf(nameBytes);
    check(!names.has(name.toLowerCase()), "duplicate path");
    names.add(name.toLowerCase());
    check(local + 30 <= start && b.readUInt32LE(local) === 0x04034b50, "local header");
    check(b.readUInt16LE(local + 6) === flags && b.readUInt16LE(local + 8) === method, "header mismatch");
    const localNameLength = b.readUInt16LE(local + 26),
      localExtraLength = b.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    check(
      dataStart + packed <= start && b.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes),
      "local bounds or name mismatch",
    );
    if (!(flags & 8))
      check(
        b.readUInt32LE(local + 14) === crc &&
          b.readUInt32LE(local + 18) === packed &&
          b.readUInt32LE(local + 22) === unpacked,
        "local size or CRC mismatch",
      );
    check((total += unpacked) <= LIMIT, "expanded size limit");
    const compressed = b.subarray(dataStart, dataStart + packed);
    const bytes =
      method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, unpacked) });
    check(bytes.length === unpacked && crc32(bytes) === crc, "size or CRC mismatch");
    if (name.endsWith("/")) check(bytes.length === 0, "directory data");
    else result.set(name, bytes);
    ranges.push([local, dataStart + packed]);
    p += 46 + nameLength + extraLength + commentLength;
  }
  check(p === end, "central directory size");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) check(ranges[i][0] >= ranges[i - 1][1], "overlapping entries");
  for (const name of result.keys()) {
    const pieces = name.split("/");
    for (let i = 1; i < pieces.length; i++) check(!result.has(pieces.slice(0, i).join("/")), "file/directory conflict");
  }
  return result;
}

export function writeZip(files) {
  const local = [],
    central = [];
  let offset = 0,
    total = 0;
  check(files instanceof Map && files.size < 65535, "file collection");
  for (const [name, value] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const nameBytes = Buffer.from(name),
      bytes = Buffer.from(value);
    check(nameOf(nameBytes) === name && !name.endsWith("/") && nameBytes.length < 65536, "file path");
    check((total += bytes.length) <= LIMIT, "expanded size limit");
    const compressed = deflateRawSync(bytes, { level: 9 }),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]);
  readZip(result);
  return result;
}

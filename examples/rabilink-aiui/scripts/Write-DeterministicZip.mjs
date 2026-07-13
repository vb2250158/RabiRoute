import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function fail(message) {
  throw new Error(message);
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = crc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  // 2024-01-01 00:00:00. The DOS time format stores seconds divided by two.
  return {
    time: 0,
    date: ((2024 - 1980) << 9) | (1 << 5) | 1
  };
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value >>> 0);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function collectFiles(root, relative = "") {
  const fullRoot = path.join(root, relative);
  const entries = fs.readdirSync(fullRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    const fullPath = path.join(root, nextRelative);
    if (entry.isDirectory()) {
      files.push(...collectFiles(root, nextRelative));
    } else if (entry.isFile()) {
      files.push({
        fullPath,
        zipPath: nextRelative.replace(/\\/g, "/")
      });
    }
  }
  return files.sort((left, right) => left.zipPath.localeCompare(right.zipPath, "en"));
}

function localFileHeader(entry, offset) {
  const { time, date } = dosDateTime();
  const name = Buffer.from(entry.zipPath, "utf8");
  return {
    offset,
    buffer: Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(8),
      uint16(time),
      uint16(date),
      uint32(entry.crc),
      uint32(entry.compressed.length),
      uint32(entry.uncompressed.length),
      uint16(name.length),
      uint16(0),
      name
    ])
  };
}

function centralDirectoryHeader(entry) {
  const { time, date } = dosDateTime();
  const name = Buffer.from(entry.zipPath, "utf8");
  return Buffer.concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0x0800),
    uint16(8),
    uint16(time),
    uint16(date),
    uint32(entry.crc),
    uint32(entry.compressed.length),
    uint32(entry.uncompressed.length),
    uint16(name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(entry.offset),
    name
  ]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entryCount),
    uint16(entryCount),
    uint32(centralSize),
    uint32(centralOffset),
    uint16(0)
  ]);
}

export function writeDeterministicZip(sourceRoot, outputPath) {
  const resolvedSource = path.resolve(sourceRoot);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    fail(`Source root is not a directory: ${resolvedSource}`);
  }

  const fileEntries = collectFiles(resolvedSource).map((file) => {
    const uncompressed = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(uncompressed, { level: 9 });
    return {
      ...file,
      uncompressed,
      compressed,
      crc: crc32(uncompressed)
    };
  });

  const parts = [];
  let offset = 0;
  for (const entry of fileEntries) {
    const header = localFileHeader(entry, offset);
    entry.offset = header.offset;
    parts.push(header.buffer, entry.compressed);
    offset += header.buffer.length + entry.compressed.length;
  }

  const centralOffset = offset;
  const centralParts = fileEntries.map(centralDirectoryHeader);
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  parts.push(...centralParts, endOfCentralDirectory(fileEntries.length, centralSize, centralOffset));

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat(parts));
}

if (process.argv[1] === import.meta.filename) {
  const sourceRoot = process.argv[2] || "";
  const outputPath = process.argv[3] || "";
  if (!sourceRoot || !outputPath) {
    fail("Usage: node Write-DeterministicZip.mjs <source-root> <output.zip>");
  }
  writeDeterministicZip(sourceRoot, outputPath);
  console.log(`Wrote deterministic zip: ${path.resolve(outputPath)}`);
}

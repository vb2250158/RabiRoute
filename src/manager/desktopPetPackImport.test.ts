import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importDesktopPetPack } from "./desktopPetPackImport.js";

function storedZip(files: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const encodedName = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    locals.push(local, encodedName, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(encodedName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, encodedName);
    offset += local.length + encodedName.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

test("desktop pet ZIP imports one persona-owned pack without scripts", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-pet-import-"));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id: "night-pack",
    name: "Night",
    personaId: "YeYu",
    states: { idle: { type: "gif", source: "idle.gif" } }
  }));
  const archive = storedZip([["night/pet-pack.json", manifest], ["night/idle.gif", Buffer.from("GIF89a")]]);

  const packId = importDesktopPetPack("YeYu", roleDir, "night.zip", "application/zip", archive);

  assert.equal(packId, "night-pack");
  assert.equal(fs.existsSync(path.join(roleDir, "desktop-pet", "packs", "night-pack", "idle.gif")), true);
});
test("desktop pet ZIP rejects path traversal before writing outside staging", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-pet-import-"));
  const archive = storedZip([["../escape.gif", Buffer.from("GIF89a")]]);

  assert.throws(() => importDesktopPetPack("YeYu", roleDir, "bad.zip", "application/zip", archive), /traversal/);
  assert.equal(fs.existsSync(path.join(roleDir, "escape.gif")), false);
});

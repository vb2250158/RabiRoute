import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitDesktopPetPackDirectory,
  copyDesktopPetPackDirectory,
  desktopPetImportStagingRoot,
  importDesktopPetPack,
  retryTransientFileOperation,
} from "./desktopPetPackImport.js";

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

test("desktop pet pack commit falls back to manifest-last copy when SMB rename is denied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-pet-smb-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "pack");
  fs.mkdirSync(path.join(source, "frames"), { recursive: true });
  fs.writeFileSync(path.join(source, "frames", "idle_0001.png"), "png");
  fs.writeFileSync(path.join(source, "pet-pack.json"), "{}");
  const deniedRename = () => {
    throw Object.assign(new Error("SMB rename denied"), { code: "EPERM" });
  };

  commitDesktopPetPackDirectory(source, destination, deniedRename);

  assert.equal(fs.readFileSync(path.join(destination, "frames", "idle_0001.png"), "utf8"), "png");
  assert.equal(fs.readFileSync(path.join(destination, "pet-pack.json"), "utf8"), "{}");
});

test("desktop pet imports stage locally when the persona directory is on UNC storage", () => {
  const localTemp = path.join(os.tmpdir(), "rabi-pet-local-stage-test");

  assert.equal(
    desktopPetImportStagingRoot("\\\\SmartStorage\\DigitalLife\\RabiRoute\\data\\roles\\YeYu", localTemp),
    path.join(localTemp, "rabiroute-desktop-pet-imports"),
  );
  assert.equal(
    desktopPetImportStagingRoot(path.join(localTemp, "roles", "YeYu"), localTemp),
    path.join(localTemp, "roles", "YeYu", "desktop-pet", ".imports"),
  );
});

test("desktop pet cache copy preserves a runnable source pack", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-pet-cache-copy-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "runtime", "pack");
  fs.mkdirSync(path.join(source, "frames", "drag"), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(path.join(source, "frames", "drag", "drag_0001.png"), "png");
  fs.writeFileSync(path.join(source, "pet-pack.json"), "{}", "utf8");

  copyDesktopPetPackDirectory(source, destination);

  assert.equal(fs.readFileSync(path.join(destination, "frames", "drag", "drag_0001.png"), "utf8"), "png");
  assert.equal(fs.readFileSync(path.join(destination, "pet-pack.json"), "utf8"), "{}");
});

test("desktop pet NAS file operations retry bounded transient handle exhaustion", () => {
  let calls = 0;
  const waits: number[] = [];

  const result = retryTransientFileOperation(() => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("NAS handle pressure"), { code: "EMFILE" });
    return "copied";
  }, { retries: 4, retryDelayMs: 25, wait: milliseconds => waits.push(milliseconds) });

  assert.equal(result, "copied");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test("desktop pet NAS file operations do not retry permanent failures", () => {
  let calls = 0;

  assert.throws(() => retryTransientFileOperation(() => {
    calls += 1;
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  }, { wait: () => undefined }), /permission denied/);
  assert.equal(calls, 1);
});

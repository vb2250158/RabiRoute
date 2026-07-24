import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PersonaSyncService } from "./personaSync.js";

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("persona sync manifests text and binary persona assets while safely merging JSONL histories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(path.join(roleRoot, "conversation"), { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "本地人格\n", "utf8");
  fs.writeFileSync(path.join(roleRoot, "conversation", "current.jsonl"), `${JSON.stringify({ id: "local-one", time: 1, text: "本地" })}\n`, "utf8");
  fs.mkdirSync(path.join(roleRoot, "voice", "cache", "reference-audio"), { recursive: true });
  const referenceAudio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
  const avatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(roleRoot, "voice", "cache", "reference-audio", "sample.wav"), referenceAudio);
  fs.writeFileSync(path.join(roleRoot, "avatar.png"), avatar);
  fs.mkdirSync(path.join(roleRoot, "voice", "cache", "tts-audio"), { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "voice", "cache", "tts-audio", "ignored.wav"), Buffer.from([1, 2, 3]));
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));

  const manifest = await service.manifest("Rabi");
  assert.deepEqual(manifest.roles[0]?.files.map(item => item.path).sort(), [
    "avatar.png",
    "conversation/current.jsonl",
    "persona.md",
    "voice/cache/reference-audio/sample.wav"
  ]);
  assert.deepEqual(service.readFile("Rabi", "avatar.png").content, avatar);
  assert.deepEqual(service.readFile("Rabi", "voice/cache/reference-audio/sample.wav").content, referenceAudio);

  const remoteJsonl = `${JSON.stringify({ id: "remote-one", time: 2, text: "远端" })}\n`;
  const merged = service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    contentBase64: Buffer.from(remoteJsonl).toString("base64"),
    remoteHash: hash(remoteJsonl),
    peerId: "pc-b"
  });
  assert.equal(merged.status, "merged");
  const rows = fs.readFileSync(path.join(roleRoot, "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.id), ["local-one", "remote-one"]);
  assert.ok(merged.archivePath);

  const remoteReference = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x22, 0x33, 0x44, 0x55]);
  const binaryMerge = service.merge({
    roleId: "Rabi",
    path: "voice/cache/reference-audio/remote.wav",
    contentBase64: remoteReference.toString("base64"),
    remoteHash: hash(remoteReference),
    peerId: "pc-b"
  });
  assert.equal(binaryMerge.status, "created");
  assert.deepEqual(fs.readFileSync(path.join(roleRoot, "voice", "cache", "reference-audio", "remote.wav")), remoteReference);
});

test("persona sync fast-forwards from a known base and preserves divergent files as conflicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "base\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  const fastForward = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote change\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(fastForward.status, "fast_forwarded");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "remote change\n");

  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "local divergent\n");
  assert.ok(conflict.conflictPath);
  assert.equal(fs.existsSync(path.join(root, "sync-state", conflict.conflictPath!)), true);
  const conflicts = service.listConflicts("Rabi");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.path, "persona.md");
  assert.equal(conflicts[0]?.localHash, hash("local divergent\n"));
  assert.equal(service.readConflict(conflicts[0]!.conflictId).content.toString("utf8"), "remote divergent\n");
  assert.throws(() => service.resolveConflict({
    conflictId: conflicts[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("stale\n")
  }), /stale local file hash/);
  const resolved = service.resolveConflict({
    conflictId: conflicts[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("local divergent\n")
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.action, "use_remote");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "remote divergent\n");
  assert.equal(service.listConflicts("Rabi").length, 0);
  assert.equal(fs.existsSync(path.join(root, "sync-state", resolved.resolutionPath)), true);
  assert.equal(fs.existsSync(path.join(root, "sync-state", `${resolved.resolutionPath}.resolution.json`)), true);
});

test("persona sync conflict resolution can retain local or publish explicit merged content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-resolve-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  const target = path.join(roleRoot, "persona.md");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  fs.writeFileSync(target, "local one\n", "utf8");
  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote one\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  const keep = service.listConflicts("Rabi")[0]!;
  const kept = service.resolveConflict({
    conflictId: keep.conflictId,
    action: "keep_local",
    expectedLocalHash: hash("local one\n")
  });
  assert.equal(kept.resultHash, hash("local one\n"));
  assert.equal(fs.readFileSync(target, "utf8"), "local one\n");

  fs.writeFileSync(target, "local two\n", "utf8");
  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote two\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  const merge = service.listConflicts("Rabi")[0]!;
  const merged = service.resolveConflict({
    conflictId: merge.conflictId,
    action: "use_merged",
    contentBase64: Buffer.from("explicit merged\n").toString("base64"),
    expectedLocalHash: hash("local two\n")
  });
  assert.equal(merged.resultHash, hash("explicit merged\n"));
  assert.equal(fs.readFileSync(target, "utf8"), "explicit merged\n");
});

test("persona sync propagates a based deletion and preserves delete-versus-edit evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-delete-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const target = path.join(roleRoot, "persona.md");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(target, "base\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  const deleted = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    deleted: true,
    remoteHash: "deleted",
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(deleted.status, "fast_forwarded");
  assert.equal(deleted.remoteDeleted, true);
  assert.equal(fs.existsSync(target), false);
  assert.ok(deleted.archivePath);

  fs.writeFileSync(target, "local edit\n", "utf8");
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    deleted: true,
    remoteHash: "deleted",
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(conflict.status, "conflict");
  const listed = service.listConflicts("Rabi");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.remoteDeleted, true);
  assert.equal(listed[0]?.peerId, "pc-b");
  assert.equal(listed[0]?.baseHash, baseHash);
  assert.equal(service.readConflict(listed[0]!.conflictId).content.byteLength, 0);

  const resolved = service.resolveConflict({
    conflictId: listed[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("local edit\n")
  });
  assert.equal(resolved.remoteDeleted, true);
  assert.equal(fs.existsSync(target), false);
  assert.ok(resolved.archivePath);
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    deleted: true,
    remoteHash: "deleted",
    baseHash
  }), /union\/tombstone semantics/);
});

test("persona sync shares the live conversation lock before replacing current context", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-live-lock-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const conversationDir = path.join(roleRoot, "conversation");
  const lockPath = path.join(conversationDir, ".message-context.lock");
  const readyPath = path.join(root, "lock-ready");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "current.jsonl"), `${JSON.stringify({ id: "local", time: 1 })}\n`, "utf8");
  const holder = spawn(process.execPath, [
    "-e",
    [
      "const fs=require('node:fs');",
      "const lock=process.argv[1];",
      "const ready=process.argv[2];",
      "fs.writeFileSync(lock, 'held\\n');",
      "fs.writeFileSync(ready, 'ready\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);",
      "fs.unlinkSync(lock);"
    ].join(""),
    lockPath,
    readyPath
  ], { stdio: "ignore" });
  t.after(() => {
    if (holder.exitCode == null) holder.kill();
  });
  await waitForFile(readyPath);

  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const remoteJsonl = `${JSON.stringify({ id: "remote", time: 2 })}\n`;
  const startedAt = Date.now();
  const result = service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    contentBase64: Buffer.from(remoteJsonl).toString("base64")
  });
  const elapsedMs = Date.now() - startedAt;
  if (holder.exitCode == null) await once(holder, "exit");

  assert.equal(result.status, "merged");
  assert.ok(elapsedMs >= 200, `Expected merge to wait for the live conversation lock, waited ${elapsedMs}ms.`);
});

test("persona sync refuses files reached through persona symlinks or junctions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-link-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const outside = path.join(root, "outside");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "outside\n", "utf8");
  try {
    fs.symlinkSync(outside, path.join(roleRoot, "linked"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This Windows environment does not permit junction creation.");
      return;
    }
    throw error;
  }
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));

  assert.equal((await service.manifest("Rabi")).roles[0]?.files.some(file => file.path.startsWith("linked/")), false);
  assert.throws(() => service.readFile("Rabi", "linked/secret.md"), /symbolic links|junctions/i);
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "linked/new.md",
    contentBase64: Buffer.from("blocked\n").toString("base64")
  }), /symbolic links|junctions/i);
  assert.equal(fs.existsSync(path.join(outside, "new.md")), false);
});

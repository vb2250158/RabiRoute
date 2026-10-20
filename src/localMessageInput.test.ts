import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { readLocalMessageText } from "./localMessageInput.js";

test("local messages preserve large persona prompts across a real child stdin pipe", async () => {
  const text = "角色陪伴上下文与历史摘要😀\n".repeat(3000);
  assert.ok(encodeURIComponent(text).length > 32_767);
  const child = spawn(process.execPath, ["--input-type=module", "-e", "process.stdin.pipe(process.stdout)"], { windowsHide: true });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Child exit ${code}`)));
    child.stdin.once("error", reject);
  });
  const received = readLocalMessageText(child.stdout);
  child.stdin.end(text, "utf8");
  assert.equal(await received, text);
  await exited;
});

test("stdin size and encoding are validated without damaging multibyte chunks", async () => {
  const text = "同一角色😀";
  const buffer = Buffer.from(text);
  assert.equal(await readLocalMessageText(Readable.from([buffer.subarray(0, 2), buffer.subarray(2)])), text);
  await assert.rejects(readLocalMessageText(Readable.from([Buffer.alloc(256 * 1024 + 1)])), /exceeds/);
  await assert.rejects(readLocalMessageText(Readable.from([Buffer.from([0xff])])), /encoded data/);
});

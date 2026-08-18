import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoalescingMessageProcessingBoardPersistence,
  type MessageProcessingBoardSnapshotWriter
} from "./persistence.js";

test("message-processing persistence coalesces queued snapshots", async () => {
  const writes: unknown[] = [];
  let releaseWrite: (() => void) | undefined;
  let persistence!: CoalescingMessageProcessingBoardPersistence;
  const writeStarted = new Promise<void>((resolve) => {
    const writer: MessageProcessingBoardSnapshotWriter = async (_statePath, state) => {
      writes.push(state);
      resolve();
      await new Promise<void>((release) => { releaseWrite = release; });
    };
    persistence = new CoalescingMessageProcessingBoardPersistence("unused.json", {
      flushDelayMs: 60_000,
      writer
    });
  });

  persistence.write({ revision: 1 });
  persistence.write({ revision: 2 });
  persistence.write({ revision: 3 });
  assert.equal(persistence.status().state, "pending");
  const flushing = persistence.flush();
  await writeStarted;

  assert.deepEqual(writes, [{ revision: 3 }]);
  assert.equal(persistence.status().state, "writing");
  releaseWrite?.();
  await flushing;
  assert.equal(persistence.status().state, "idle");
});

test("message-processing persistence keeps only the newest snapshot while a write is active", async () => {
  const writes: unknown[] = [];
  const releases: Array<() => void> = [];
  const writer: MessageProcessingBoardSnapshotWriter = async (_statePath, state) => {
    writes.push(state);
    await new Promise<void>((resolve) => releases.push(resolve));
  };
  const persistence = new CoalescingMessageProcessingBoardPersistence("unused.json", {
    flushDelayMs: 0,
    writer
  });

  persistence.write({ revision: 1 });
  while (writes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  persistence.write({ revision: 2 });
  persistence.write({ revision: 3 });
  releases.shift()?.();
  while (writes.length < 2) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, [{ revision: 1 }, { revision: 3 }]);
  releases.shift()?.();
  await persistence.flush();
});

test("message-processing persistence writes compact atomic JSON off the caller path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-persistence-"));
  const statePath = path.join(root, "board.json");
  const persistence = new CoalescingMessageProcessingBoardPersistence(statePath, { flushDelayMs: 0 });
  const state = { schemaVersion: 1, requirements: [{ id: "req-1", summary: "payload" }], planOrigins: [] };

  persistence.write(state);
  assert.equal(fs.existsSync(statePath), false);
  await persistence.flush();

  const text = fs.readFileSync(statePath, "utf8");
  assert.deepEqual(JSON.parse(text), state);
  assert.equal(text.includes("\n  "), false);
});

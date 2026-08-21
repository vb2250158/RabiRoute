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

test("message-processing persistence stop flushes the latest snapshot and allows restart", async () => {
  const writes: unknown[] = [];
  const persistence = new CoalescingMessageProcessingBoardPersistence("unused.json", {
    flushDelayMs: 60_000,
    writer: async (_statePath, state) => { writes.push(state); }
  });

  persistence.write({ revision: 1 });
  persistence.write({ revision: 2 });
  const firstStop = persistence.stop();
  const secondStop = persistence.stop();
  assert.strictEqual(secondStop, firstStop);
  await firstStop;
  assert.deepEqual(writes, [{ revision: 2 }]);
  assert.throws(() => persistence.write({ revision: 3 }), /persistence is stopped/);

  persistence.start();
  persistence.write({ revision: 3 });
  await persistence.stop();
  assert.deepEqual(writes, [{ revision: 2 }, { revision: 3 }]);
});

test("message-processing persistence stop waits for an active write and its coalesced successor", async () => {
  const writes: unknown[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const persistence = new CoalescingMessageProcessingBoardPersistence("unused.json", {
    flushDelayMs: 0,
    writer: async (_statePath, state) => {
      writes.push(state);
      if (writes.length === 1) {
        firstStarted();
        await firstGate;
      }
    }
  });

  persistence.write({ revision: 1 });
  await started;
  persistence.write({ revision: 2 });
  const stopping = persistence.stop();
  assert.throws(() => persistence.write({ revision: 3 }), /persistence is stopped/);
  releaseFirst();
  await stopping;

  assert.deepEqual(writes, [{ revision: 1 }, { revision: 2 }]);
  assert.equal(persistence.status().state, "idle");
});

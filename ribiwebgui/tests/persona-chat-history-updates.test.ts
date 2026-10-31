import assert from "node:assert/strict";
import test from "node:test";
import { retainChatHistoryWindow, mergeChatHistoryBatch, readChatHistoryAddition } from "../src/personaChatHistoryUpdates";
import type { PersonaChatReply } from "../../src/shared/personaChatHistory";

const entry = (id: string): PersonaChatReply => ({ id, sessionId: "task", turnId: id, text: id, receivedAt: "2026-09-08T00:00:00Z" });

test("initial load reads one page and preserves the older cursor", async () => {
  const result = await readChatHistoryAddition(new Set(), async cursor => {
    assert.equal(cursor, undefined);
    return { entries: [entry("a")], nextCursor: 20 };
  });
  assert.equal(result.nextCursor, 20);
  assert.deepEqual(result.entries.map(e => e.id), ["a"]);
});

test("reconnect catches up multiple pages once and stops at the existing boundary", async () => {
  const cursors: (number | undefined)[] = [];
  const result = await readChatHistoryAddition(new Set(["old"]), async cursor => {
    cursors.push(cursor);
    return cursor === undefined
      ? { entries: [entry("new2"), entry("new1")], nextCursor: 20 }
      : { entries: [entry("new1"), entry("old"), entry("unloaded-older")], nextCursor: 10 };
  });
  assert.deepEqual(cursors, [undefined, 20]);
  assert.deepEqual(result.entries.map(e => e.id), ["new2", "new1"]);
});

test("replayed events add nothing and read failures are surfaced without mutating known entries", async () => {
  const known = new Set(["old"]);
  assert.deepEqual((await readChatHistoryAddition(known, async () => ({ entries: [entry("old")], nextCursor: null }))).entries, []);
  await assert.rejects(readChatHistoryAddition(known, async () => { throw new Error("offline"); }), /offline/);
  assert.deepEqual([...known], ["old"]);
});

test("invalid repeated cursors fail instead of looping forever", async () => {
  await assert.rejects(readChatHistoryAddition(new Set(["old"]), async () => ({ entries: [entry("new")], nextCursor: 1 })), /did not advance/);
});

test("reconnect batches have a page budget and resume without losing the gap", async () => {
  const known = new Set(["old"]);
  const calls: (number | undefined)[] = [];
  const read = async (cursor?: number) => {
    calls.push(cursor);
    return cursor === undefined ? { entries: [entry("5")], nextCursor: 50 }
      : cursor === 50 ? { entries: [entry("4")], nextCursor: 40 }
      : cursor === 40 ? { entries: [entry("3")], nextCursor: 30 }
      : { entries: [entry("2"), entry("old")], nextCursor: 20 };
  };
  const first = await readChatHistoryAddition(known, read);
  assert.deepEqual(calls, [undefined, 50, 40]);
  assert.equal(first.continuationCursor, 30);
  const second = await readChatHistoryAddition(known, read, { cursor: first.continuationCursor! });
  assert.equal(second.continuationCursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map(e => e.id), ["5", "4", "3", "2"]);
});

test("continuation failure preserves the retry cursor and does not mutate the known window", async () => {
  const known = new Set(["old"]);
  await assert.rejects(readChatHistoryAddition(known, async () => { throw Error("offline"); }, { cursor: 30 }), /offline/);
  assert.deepEqual([...known], ["old"]);
  await assert.rejects(readChatHistoryAddition(known, async () => ({ entries: [], nextCursor: 30 }), { cursor: 30 }), /did not advance/);
});

test("empty filtered pages retain a continuation and an eventual known boundary", async () => {
  const known = new Set(["old"]);
  const first = await readChatHistoryAddition(known, async cursor => ({ entries: [], nextCursor: cursor === undefined ? 60 : cursor - 10 }));
  assert.equal(first.continuationCursor, 40);
  const second = await readChatHistoryAddition(known, async () => ({ entries: [entry("new"), entry("old")], nextCursor: null }), { cursor: first.continuationCursor! });
  assert.deepEqual(second.entries.map(e => e.id), ["new"]);
  assert.equal(second.continuationCursor, null);
});

test("large gaps are resumed in finite batches without repeated or omitted records", async () => {
  const total = 1000;
  let cursor: number | undefined;
  let requests = 0;
  const loaded: string[] = [];
  do {
    const before = requests;
    const page = await readChatHistoryAddition(new Set(["old"]), async value => {
      requests++;
      const n = value ?? total;
      return n === 0 ? { entries: [entry("old")], nextCursor: null }
        : { entries: [entry(String(n))], nextCursor: n - 1 };
    }, { cursor });
    assert.ok(requests - before <= 3);
    loaded.push(...page.entries.map(e => e.id));
    cursor = page.continuationCursor ?? undefined;
  } while (cursor !== undefined);
  assert.equal(requests, total + 1);
  assert.deepEqual(loaded, Array.from({ length: total }, (_, i) => String(total - i)));
});

test("fresh messages remain visible while an older gap is outstanding, and one frontier bridges known islands", async () => {
  let newest = 10;
  const read = async (cursor?: number) => {
    const n = cursor ?? newest;
    return { entries: [entry(String(n))], nextCursor: n === 0 ? null : n - 1 };
  };
  const boundary = new Set(["0"]);
  let current = [entry("0")];
  let batch = await readChatHistoryAddition(boundary, read);
  current = mergeChatHistoryBatch(current, batch.entries);
  assert.equal(batch.continuationCursor, 7);
  newest = 15;
  batch = await readChatHistoryAddition(boundary, read);
  current = mergeChatHistoryBatch(current, batch.entries);
  assert.deepEqual(current.map(e => e.id), ["15", "14", "13", "10", "9", "8", "0"]);
  let afterId = batch.entries.at(-1)?.id;
  while (batch.continuationCursor !== null) {
    batch = await readChatHistoryAddition(boundary, read, { cursor: batch.continuationCursor });
    current = mergeChatHistoryBatch(current, batch.entries, afterId);
    afterId = batch.entries.at(-1)?.id ?? afterId;
  }
  assert.deepEqual(current.map(e => e.id), Array.from({length: 16}, (_, i) => String(15 - i)));
});


test('bounded history window retains a reading anchor and exposes discarded directions', () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), text: 'summary', sessionId: 'task', receivedAt: '' }));
  const middle = retainChatHistoryWindow(entries, '500');
  assert.equal(middle.entries.length, 200); assert.ok(middle.entries.some(row => row.id === '500'));
  assert.equal(middle.trimmedNewer, true); assert.equal(middle.trimmedOlder, true);
  const oldest = retainChatHistoryWindow(entries, '950', true);
  assert.equal(oldest.entries[0].id, '800'); assert.equal(oldest.trimmedOlder, false);
  assert.equal(retainChatHistoryWindow(entries).entries[0].id, '0');
});


test('first-page diagnostics and newer boundary survive bounded refresh aggregation', async () => {
  const result = await readChatHistoryAddition(new Set(), async () => ({ entries: [], nextCursor: 4, newerCursor: 20, invalidRecords: 2 }));
  assert.equal(result.invalidRecords, 2); assert.equal(result.newerCursor, 20);
});

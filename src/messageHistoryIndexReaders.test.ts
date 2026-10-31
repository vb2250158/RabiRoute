import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeMessageHistoryReaders } from "./messageHistoryIndexReaders.js";
import { refreshMessageHistoryIndex, searchMessageHistoryIndex } from "./messageHistorySearchIndex.js";
import { acquireMessageIndexLease, collectMessageIndexGenerations } from "./messageHistoryIndexLifecycle.js";

test("resident readers see committed updates, switch generations and release retired files on shutdown", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-resident-reader-"));
  const original = process.env.RABIROUTE_MANAGER_READ_PROCESS;
  process.env.RABIROUTE_MANAGER_READ_PROCESS = "1";
  t.after(() => {
    closeMessageHistoryReaders();
    if (original === undefined) delete process.env.RABIROUTE_MANAGER_READ_PROCESS; else process.env.RABIROUTE_MANAGER_READ_PROCESS = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "role"); fs.mkdirSync(path.join(directory, "conversation"), { recursive: true });
  const current = path.join(directory, "conversation/current.jsonl");
  const row = (sequence: number) => JSON.stringify({ id: String(sequence), sequence, time: sequence, text: "resident reader", adapter: "synthetic" }) + "\n";
  fs.writeFileSync(current, row(1));
  const index = path.join(root, "search.sqlite");
  refreshMessageHistoryIndex(directory, index);
  const first = acquireMessageIndexLease(index); first.release();
  assert.equal(searchMessageHistoryIndex(directory, { limit: 10 }, index).length, 1);
  fs.appendFileSync(current, row(2)); refreshMessageHistoryIndex(directory, index);
  assert.equal(searchMessageHistoryIndex(directory, { limit: 10 }, index).length, 2);
  refreshMessageHistoryIndex(directory, index, { rebuild: true });
  assert.equal(searchMessageHistoryIndex(directory, { limit: 10 }, index).length, 2);
  refreshMessageHistoryIndex(directory, index, { rebuild: true });
  collectMessageIndexGenerations(index); assert.equal(fs.existsSync(first.databasePath), true);
  closeMessageHistoryReaders(); collectMessageIndexGenerations(index);
  assert.equal(fs.existsSync(first.databasePath), false);
});

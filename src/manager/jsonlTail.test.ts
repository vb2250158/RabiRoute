import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonlTail } from "./jsonlTail.js";

test("JSONL tail reads only the newest bounded records from a large file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-jsonl-tail-"));
  const file = path.join(root, "large.jsonl");
  const rows = Array.from({ length: 20_000 }, (_, index) => JSON.stringify({ index, text: "x".repeat(120) }));
  fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");

  const tail = readJsonlTail(file, 3, { initialBytes: 4 * 1024, maxBytes: 16 * 1024 });

  assert.deepEqual(tail.map(item => item.index), [19_997, 19_998, 19_999]);
});

test("JSONL tail keeps malformed final records visible for diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-jsonl-tail-malformed-"));
  const file = path.join(root, "events.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ ok: true })}\nnot-json\n`, "utf8");

  assert.deepEqual(readJsonlTail(file, 2), [{ ok: true }, { rawLine: "not-json" }]);
});

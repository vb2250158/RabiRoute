import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleByteRange } from "./artifactAccess.js";

test("parses bounded and suffix video byte ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseSingleByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.throws(() => parseSingleByteRange("bytes=100-101", 100), /invalid/);
  assert.throws(() => parseSingleByteRange("bytes=0-1,4-5", 100), /invalid/);
});

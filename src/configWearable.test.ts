import test from "node:test";
import assert from "node:assert/strict";
import { parseMessageAdapterType, parseMessageAdapterTypes } from "./config.js";

test("wearable is preserved as a configured message adapter", () => {
  assert.equal(parseMessageAdapterType("wearable"), "wearable");
  assert.deepEqual(parseMessageAdapterTypes('["wearable"]', undefined), ["wearable"]);
  assert.deepEqual(parseMessageAdapterTypes('["rabilink","wearable"]', undefined), ["rabilink", "wearable"]);
});

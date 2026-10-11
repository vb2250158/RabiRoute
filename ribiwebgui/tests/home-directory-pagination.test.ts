import assert from "node:assert/strict";
import test from "node:test";
import { readHomeDirectory } from "../src/homeDirectoryClient.js";
import type { HomeDirectoryPage } from "../../src/shared/homeDeviceQueryContract.js";

test("WebGUI collects detail pages and refuses incomplete or non-advancing responses", async () => {
  const expected = [1, 2, 3, 4, 5];
  const page = (offset = 0): HomeDirectoryPage<number> => ({ schemaVersion: 1, view: "detail", observedAt: "fixture",
    items: expected.slice(offset, offset + 2), total: 5, offset, limit: 2, nextOffset: offset + 2 < 5 ? offset + 2 : null });
  assert.deepEqual(await readHomeDirectory("/devices?view=detail&limit=2", async path => page(Number(new URL(path, "http://localhost").searchParams.get("offset")))), expected);
  await assert.rejects(readHomeDirectory("/devices", async () => ({ ...page(), nextOffset: 0 })), /did not advance/);
  await assert.rejects(readHomeDirectory("/devices", async () => ({ ...page(), items: [1], nextOffset: null })), /incomplete/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { browserUuid } from "../src/browserUuid.ts";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("UUIDs work with the crypto API available on LAN HTTP, without randomUUID", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  });
  assert.equal(typeof globalThis.crypto.randomUUID, "undefined");
  const ids = Array.from({ length: 1000 }, () => browserUuid());
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});

test("UUID generation preserves v4 format with either extreme random byte value", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  for (const value of [0, 255]) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(value) }
    });
    assert.match(browserUuid(), uuidV4);
  }
});

test("randomness failure propagates rather than producing a weak or repeated ID", t => {
  const failure = new Error("Random source unavailable");
  t.mock.method(globalThis.crypto, "getRandomValues", () => { throw failure; });
  assert.throws(() => browserUuid(), failure);
});

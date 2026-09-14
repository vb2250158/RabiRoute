import assert from "node:assert/strict";
import test from "node:test";

import { compareTupleParity } from "./rabi-mobile-tuple-parity.mjs";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const sourceDeviceId = "rabi-phone-test";
const phone = [
  { sourceDeviceId, sourceSequence: 1, streamSequence: 11, chunkId: "audio-00000000000000000001", acceptedBytes: 4, sha256: shaA },
  { sourceDeviceId, sourceSequence: 2, streamSequence: 12, chunkId: "audio-00000000000000000002", acceptedBytes: 4, sha256: shaB },
];

test("accepts one-to-one ordered terminal tuple parity", () => {
  const server = phone.map((row) => ({ ...row, terminal: true, terminalStatus: "processed" }));
  assert.deepEqual(compareTupleParity(phone, server), {
    matched: true, records: 2, bytes: 8, firstSourceSequence: 1, lastSourceSequence: 2,
  });
});

test("equal aggregate bytes and count cannot hide one duplicate plus one missing tuple", () => {
  const server = [
    { ...phone[0], terminal: true, terminalStatus: "processed" },
    { ...phone[0], sourceSequence: 2, streamSequence: 12, terminal: true, terminalStatus: "processed" },
  ];
  assert.equal(server.length, phone.length);
  assert.equal(
    server.reduce((sum, row) => sum + row.acceptedBytes, 0),
    phone.reduce((sum, row) => sum + row.acceptedBytes, 0),
  );
  assert.throws(() => compareTupleParity(phone, server), /duplicate chunk id|chunkId mismatch/);
});

test("substitution with the same byte count fails", () => {
  const server = phone.map((row) => ({ ...row, terminal: true, terminalStatus: "processed" }));
  server[1] = { ...server[1], sha256: shaA };
  assert.throws(() => compareTupleParity(phone, server), /sha256 mismatch/);
});

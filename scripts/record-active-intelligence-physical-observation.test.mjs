import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordPhysicalObservation } from "./record-active-intelligence-physical-observation.mjs";

const FIRST_NOW = new Date("2026-07-24T12:00:00.000Z");
const SECOND_NOW = new Date("2026-07-24T13:00:00.000Z");

test("records only explicitly confirmed checks and stores only a hashed environment identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-physical-observation-"));
  const outputPath = path.join(root, "observation.json");
  const result = recordPhysicalObservation({
    confirm: ["androidOfflineRecovery"],
    outputPath
  }, {
    now: () => FIRST_NOW,
    randomBytes: size => Buffer.alloc(size, 7)
  });

  assert.equal(result.payload.checks.androidOfflineRecovery, true);
  assert.equal(result.payload.checks.androidBootRecovery, false);
  assert.match(result.payload.environmentIdHash, /^[0-9a-f]{64}$/);
  const text = fs.readFileSync(outputPath, "utf8");
  assert.equal(text.includes(Buffer.alloc(32, 7).toString("hex")), false);
  assert.equal(result.archivePath, "");
});

test("archives the previous observation and preserves confirmations across updates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-physical-observation-archive-"));
  const outputPath = path.join(root, "observation.json");
  const first = recordPhysicalObservation({ confirm: ["personaSyncLan"], outputPath }, {
    now: () => FIRST_NOW,
    randomBytes: size => Buffer.alloc(size, 3)
  });
  const second = recordPhysicalObservation({ confirm: ["personaSyncRelayFallback"], outputPath }, {
    now: () => SECOND_NOW,
    randomBytes: size => Buffer.alloc(size, 9)
  });

  assert.equal(second.payload.checks.personaSyncLan, true);
  assert.equal(second.payload.checks.personaSyncRelayFallback, true);
  assert.equal(second.payload.environmentIdHash, first.payload.environmentIdHash);
  assert.equal(fs.existsSync(second.archivePath), true);
  const archived = JSON.parse(fs.readFileSync(second.archivePath, "utf8"));
  assert.equal(archived.checks.personaSyncLan, true);
  assert.equal(archived.checks.personaSyncRelayFallback, false);
});

test("revokes one check without changing unrelated observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-physical-observation-revoke-"));
  const outputPath = path.join(root, "observation.json");
  recordPhysicalObservation({ confirm: ["rokidTouchpad", "rokidPlaybackHeard"], outputPath });
  const result = recordPhysicalObservation({ revoke: ["rokidTouchpad"], outputPath });
  assert.equal(result.payload.checks.rokidTouchpad, false);
  assert.equal(result.payload.checks.rokidPlaybackHeard, true);
});

test("refuses unknown checks and implicit all-true mutations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-physical-observation-invalid-"));
  const outputPath = path.join(root, "observation.json");
  assert.throws(() => recordPhysicalObservation({ confirm: ["everythingPassed"], outputPath }), /Unknown physical observation check/);
  assert.throws(() => recordPhysicalObservation({ outputPath }), /explicit --confirm/);
});

test("reset can replace a malformed file while archiving it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-physical-observation-reset-"));
  const outputPath = path.join(root, "observation.json");
  fs.writeFileSync(outputPath, "{\"privateHost\":\"do-not-copy-to-new-payload\"}\n", "utf8");
  const result = recordPhysicalObservation({ reset: true, outputPath }, { now: () => FIRST_NOW });
  assert.equal(Object.values(result.payload.checks).every(value => value === false), true);
  assert.equal(fs.existsSync(result.archivePath), true);
  assert.equal(fs.readFileSync(outputPath, "utf8").includes("privateHost"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimMobileVoiceInput, mobileVoiceInput, validateMobileVoiceInput } from "./mobileVoiceCall.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

const now = 1791300000000;
const id = (deadline = now + 90000) => `rabi-call-v1.12345678-1234-1234-1234-123456789abc.${deadline}.${Buffer.from("pc-a").toString("base64url")}.${Buffer.from("route-a").toString("base64url")}.${"a".repeat(64)}`;
const task = (deadline?: number) => ({ clientMessageId: id(deadline), targetDeviceId: "pc-a", routeProfileId: "route-a" });
test("ordinary transcription has no live voice authorization", () => assert.equal(mobileVoiceInput("event-a"), undefined));
test("live input preserves its exact computer and route", () => {
  assert.equal(validateMobileVoiceInput(task(), "pc-a", now)?.routeId, "route-a");
  assert.throws(() => validateMobileVoiceInput(task(), "pc-b", now), /target changed/);
  assert.throws(() => validateMobileVoiceInput({ ...task(), routeProfileId: "route-b" }, "pc-a", now), /target changed/);
});
test("offline backlog and forged future deadlines fail closed", () => {
  assert.throws(() => validateMobileVoiceInput(task(now), "pc-a", now), /expired/);
  assert.throws(() => validateMobileVoiceInput(task(now + 90001), "pc-a", now), /lifetime/);
  assert.throws(() => mobileVoiceInput("rabi-call-v1.invalid"), /identity/);
});

test("durable claim rejects retries after worker restart before any second dispatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-call-claim-"));
  const records: RecordedDataMutationAudit[] = [];
  const uninstall = installDataMutationAuditSink(record => records.push(record));
  try {
    assert.throws(() => claimMobileVoiceInput(directory, { ...task(), targetDeviceId: "pc-b" }, "pc-a", now), /target changed/);
    assert.equal(fs.readdirSync(directory).length, 0);
    claimMobileVoiceInput(directory, task(), "pc-a", now);
    assert.throws(() => claimMobileVoiceInput(directory, task(), "pc-a", now + 1), /already claimed/);
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.throws(() => claimMobileVoiceInput(directory, task(), "pc-a", now + 90000), /expired/);
    assert.deepEqual(records.map(record => record.outcome), ["started", "committed"]);
    assert.ok(records.every(record => /^[a-f0-9]{64}$/.test(record.target.id)));
    assert.equal(JSON.stringify(records).includes(id()), false);
    assert.equal(JSON.stringify(records).includes(directory), false);
  } finally { uninstall(); fs.rmSync(directory, { recursive: true, force: true }); }
});

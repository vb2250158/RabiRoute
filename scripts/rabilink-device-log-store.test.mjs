import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendDeviceLogs,
  deviceLogFacets,
  readDeviceLogs,
  redactDeviceLogText,
  sanitizeDeviceLogValue
} from "./rabilink-device-log-store.mjs";

test("device logs are redacted, deduplicated, bounded and filterable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-device-logs-"));
  try {
    const first = appendDeviceLogs({
      directory,
      accountId: "account-1",
      appId: "app-1",
      appName: "RabiLink AIUI",
      maxRows: 100,
      receivedAtMs: Date.parse("2026-07-16T00:00:00.000Z"),
      body: {
        deviceId: "glass-01",
        deviceKind: "glasses",
        source: "rabilink-aiui",
        appVersion: "1.0.17",
        sessionId: "session-01",
        mode: "configuration",
        logs: [{
          id: "client-1",
          level: "error",
          event: "configuration.model.failed",
          message: "Bearer secret-value and rbl_1234567890abcdefghijkl failed",
          context: { token: "private", nested: { api_key: "private", reason: "timeout" } }
        }]
      }
    });
    assert.equal(first.acceptedCount, 1);
    assert.equal(first.accepted[0].message.includes("secret-value"), false);
    assert.equal(first.accepted[0].message.includes("rbl_"), false);
    assert.equal(first.accepted[0].context.token, "[redacted]");
    assert.equal(first.accepted[0].context.nested.api_key, "[redacted]");

    const duplicate = appendDeviceLogs({
      directory,
      accountId: "account-1",
      appId: "app-1",
      appName: "RabiLink AIUI",
      body: { deviceId: "glass-01", logs: [{ id: "client-1", message: "retry" }] }
    });
    assert.equal(duplicate.acceptedCount, 0);
    assert.equal(duplicate.duplicateCount, 1);

    appendDeviceLogs({
      directory,
      accountId: "account-1",
      appId: "app-2",
      appName: "Other Glass App",
      body: {
        deviceId: "glass-02",
        deviceKind: "glasses",
        source: "other-app",
        logs: [{ id: "client-2", level: "info", event: "startup", message: "ready" }]
      }
    });

    const errors = readDeviceLogs({ directory, accountId: "account-1", level: "error" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].deviceId, "glass-01");
    assert.equal(readDeviceLogs({ directory, accountId: "account-1", source: "other-app" }).length, 1);
    assert.equal(readDeviceLogs({ directory, accountId: "account-1", query: "startup" }).length, 1);
    assert.deepEqual(deviceLogFacets(readDeviceLogs({ directory, accountId: "account-1", limit: 500 })).devices, ["glass-01", "glass-02"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("redaction helpers remove credentials without erasing useful context", () => {
  assert.equal(redactDeviceLogText("token=private-value&mode=run"), "token=[redacted]&mode=run");
  assert.deepEqual(sanitizeDeviceLogValue({ password: "x", reason: "network timeout" }), {
    password: "[redacted]",
    reason: "network timeout"
  });
});

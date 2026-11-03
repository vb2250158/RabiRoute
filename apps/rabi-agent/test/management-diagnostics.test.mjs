import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagementDiagnostics } from "../lib/management-diagnostics.mjs";

test("management diagnostics retain bounded stages and IDs without payload or authority", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "diagnostic.json"), owner = new ManagementDiagnostics(file);
  for (let index = 0; index < 18; index++) {
    const trace = owner.begin({ requestId: `request-${index}`, operation: "reconcile_prepared_delivery", deliveryId: `delivery-${index}`, prompt: "private", credential: "secret" });
    trace.mark("receipt_wait");
    await trace.run("authority", async () => true);
    await assert.rejects(trace.run("receipt_recovery", async () => { throw new Error("private error payload"); }), /private error payload/);
    trace.mark("response", "failed");
  }
  const text = fs.readFileSync(file, "utf8"), data = JSON.parse(text);
  assert.equal(data.entries.length, 16);
  assert.equal(data.entries[0].requestId, "request-2");
  assert.equal(data.entries.at(-1).stages.authority.count, 1);
  assert.equal(data.entries.at(-1).stages.receipt_recovery.result, "failed");
  assert.doesNotMatch(text, /private|secret|credential|prompt/);
  const before = text;
  owner.begin({ requestId: "bad\nidentity", operation: "prepared_delivery", deliveryId: "id" }).mark("authority");
  owner.begin({ requestId: "valid", operation: "threads", deliveryId: "id" }).mark("authority");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("unwritable diagnostics preserve the original operation result and rejection", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-diagnostic-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "file"), "fixture");
  const trace = new ManagementDiagnostics(path.join(root, "file", "blocked.json"))
    .begin({ requestId: "request", operation: "prepared_delivery", deliveryId: "delivery" });
  assert.equal(await trace.run("authority", async () => 42), 42);
  await assert.rejects(trace.run("execute", async () => { throw new Error("original failure"); }), /original failure/);
});

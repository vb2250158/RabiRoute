import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationContext,
  installDataMutationAuditSink,
  recordDataMutationAudit,
  runWithOperationContext,
  type RecordedDataMutationAudit
} from "./dataMutationAudit.js";

test("data mutation audit inherits the active operation context", () => {
  const records: RecordedDataMutationAudit[] = [];
  const uninstall = installDataMutationAuditSink(record => records.push(record));
  try {
    const context = createOperationContext({
      traceId: "trace-1",
      spanId: "span-1",
      requestId: "request-1",
      source: "http",
      actor: { kind: "user", id: "local-user" }
    });
    runWithOperationContext(context, () => recordDataMutationAudit({
      group: "config.global",
      event: "global_config_updated",
      owner: "RabiGlobalConfigStore",
      action: "patch",
      target: { type: "global_config", id: "Config.json" },
      dataSource: { kind: "file", id: "data/Config.json" },
      outcome: "committed"
    }));
  } finally {
    uninstall();
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].traceId, "trace-1");
  assert.equal(records[0].requestId, "request-1");
  assert.deepEqual(records[0].actor, { kind: "user", id: "local-user" });
});

test("data mutation audit isolates sink failures from the mutation", () => {
  const uninstall = installDataMutationAuditSink(() => { throw new Error("sink failed"); });
  try {
    assert.doesNotThrow(() => recordDataMutationAudit({
      group: "runtime",
      event: "runtime_state_changed",
      owner: "RuntimeOwner",
      action: "update",
      target: { type: "runtime", id: "manager" },
      dataSource: { kind: "runtime", id: "manager" },
      outcome: "committed"
    }));
  } finally {
    uninstall();
  }
});

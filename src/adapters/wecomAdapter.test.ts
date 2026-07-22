import assert from "node:assert/strict";
import test from "node:test";
import type { WeComMessageRecord } from "../history.js";
import { dispatchWeComRecord } from "./wecomAdapter.js";

function record(patch: Partial<WeComMessageRecord> = {}): WeComMessageRecord {
  return {
    time: 1,
    rawMessage: "hello",
    messageId: "wecom-1",
    adapterType: "wecom",
    conversationId: "chat-1",
    messageType: "text",
    ...patch
  };
}

test("WeCom records self echoes without waking the Agent", () => {
  const calls: string[] = [];
  const disposition = dispatchWeComRecord(record({ isSelf: true }), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  });
  assert.equal(disposition, "record_only");
  assert.deepEqual(calls, ["record"]);
});

test("WeCom records unsupported inbound kinds and forwards ordinary user messages", () => {
  const calls: string[] = [];
  assert.equal(dispatchWeComRecord(record({ messageType: "video", rawMessage: "[video]" }), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  }), "record_only");
  assert.equal(dispatchWeComRecord(record(), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  }), "forwarded");
  assert.deepEqual(calls, ["record", "forward"]);
});

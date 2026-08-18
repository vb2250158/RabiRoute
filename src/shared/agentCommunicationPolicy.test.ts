import assert from "node:assert/strict";
import test from "node:test";
import {
  communicationModeForRouteKind,
  proactiveCommunicationPolicyLines
} from "./agentCommunicationPolicy.js";

test("explicit conversations require a visible acknowledgement even without plan work", () => {
  assert.equal(communicationModeForRouteKind("direct_reply"), "explicit");
  assert.equal(communicationModeForRouteKind("private"), "explicit");
  const text = proactiveCommunicationPolicyLines("explicit").join("\n");
  assert.match(text, /明确面向本角色的消息默认回复/);
  assert.match(text, /说明理解、下一步和负责人/);
  assert.match(text, /负责人/);
});

test("ambient group messages stay selective while internal work must keep moving", () => {
  assert.equal(communicationModeForRouteKind("group_message"), "ambient");
  assert.equal(communicationModeForRouteKind("heartbeat"), "heartbeat");
  assert.equal(communicationModeForRouteKind("manual_trigger"), "internal");
  const ambient = proactiveCommunicationPolicyLines("ambient").join("\n");
  assert.match(ambient, /没有新增价值时保持安静/);
  assert.match(ambient, /项目事实先核对并交回原计划或记忆/);
  assert.match(proactiveCommunicationPolicyLines("internal").join("\n"), /直接推进已授权任务/);
});

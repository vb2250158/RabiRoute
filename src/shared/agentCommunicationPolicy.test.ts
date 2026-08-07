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
  assert.match(text, /默认必须让对方看到回应/);
  assert.match(text, /无需新建计划/);
  assert.match(text, /下一步由谁做/);
});

test("ambient group messages stay selective while internal work must keep moving", () => {
  assert.equal(communicationModeForRouteKind("group_message"), "ambient");
  assert.equal(communicationModeForRouteKind("heartbeat"), "heartbeat");
  assert.equal(communicationModeForRouteKind("manual_trigger"), "internal");
  const ambient = proactiveCommunicationPolicyLines("ambient").join("\n");
  assert.match(ambient, /不要求逐条发言/);
  assert.match(ambient, /建设性想法/);
  assert.match(ambient, /不必等别人明确 @/);
  assert.match(proactiveCommunicationPolicyLines("internal").join("\n"), /不要只复述/);
});

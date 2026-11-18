import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { notificationRuleMatches } from "../routing/routeDecision.js";
import { RecordingAutomationDispatch, recordingAutomationInput } from "./recordingAutomationDispatch.js";
import { SYSTEM_EVENT_RESULT_PREFIX } from "../shared/systemEventIngress.js";
import { messageEventCategory, RECORDING_CAPTURE_TYPES } from "../shared/personaEventTypes.js";
import type { AllDayEvent } from "../shared/allDayRecording.js";
import { resolvePipeline } from "../pipelines.js";
import type { RouteProfile } from "../config.js";

test("saved captures can trigger only an explicitly selected automation and never project back as messages", () => {
  const event: AllDayEvent = { id: "fixture", source: "screen", kind: "image", state: "saved", deviceId: "fixture", startedAt: 5000, endedAt: 5000, text: "", media: "private.jpg" };
  const route: RouteProfile = { id: "fixture-route", name: "Fixture route", enabled: true, recentMessageLimit: 10, resolvedPipeline: resolvePipeline("qq_chat"), agentRoleFile: "persona.md", rolesDir: "data/roles", routeVariables: {}, notificationRules: [] };
  for (const type of RECORDING_CAPTURE_TYPES) {
    const input = recordingAutomationInput("fixture-role", { ...event, source: type.value });
    assert.ok(input);
    assert.equal(input.routeKind, type.routeKind);
    assert.equal(input.record.routeProfileId, "fixture-role");
    assert.doesNotMatch(JSON.stringify(input), /private\.jpg/);
    assert.equal(notificationRuleMatches({ id: "broad", name: "Broad", enabled: true, routeKinds: [], template: "" }, input.routeKind, input.record, {}, route), false);
    assert.equal(notificationRuleMatches({ id: "specific", name: "Specific", enabled: true, routeKinds: [input.routeKind], template: "" }, input.routeKind, input.record, {}, route), true);
    assert.equal(messageEventCategory(input.routeKind), undefined);
  }
  assert.equal(recordingAutomationInput("fixture-role", { ...event, kind: "audio", source: "microphone", transcriptionState: "pending" }), undefined);
  assert.equal(recordingAutomationInput("fixture-role", { ...event, source: "message:napcat", kind: "message" }), undefined);
  assert.equal(messageEventCategory("voice_transcript", "webhook"), "webhook");
});

test("capture dispatch writes one event to the existing gateway command and ignores duplicate commits", async () => {
  let started = 0;
  const inputParts: Buffer[] = [];
  const reports: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const dispatch = new RecordingAutomationDispatch((_roleId, routeKind) => routeKind === "recording_window" ? ["fixture-gateway"] : [], () => {
    started++;
    child.stdin.on("data", chunk => inputParts.push(chunk));
    return child as unknown as ChildProcessWithoutNullStreams;
  }, (_roleId, reason) => reports.push(reason));
  const event: AllDayEvent = { id: "fixture", source: "window", kind: "window", state: "saved", deviceId: "fixture", startedAt: 5000, endedAt: 5000, text: "Editor" };
  dispatch.accept("fixture-role", { ...event, source: "screen" });
  dispatch.accept("fixture-role", event);
  dispatch.accept("fixture-role", event);
  assert.equal(started, 1);
  assert.deepEqual(JSON.parse(Buffer.concat(inputParts).toString()), recordingAutomationInput("fixture-role", event));
  child.stdout.write(`${SYSTEM_EVENT_RESULT_PREFIX}{"status":"delivered"}\n`);
  child.emit("close", 0);
  await dispatch.dispose();
  assert.deepEqual(reports, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildXiaomiHomeEventRecord, xiaomiHomeEventTemplateValues } from "./xiaomiHomeEventDelivery.js";

test("Xiaomi Home events keep one endpoint and structured routing values", () => {
  const event = {
    id: "evt-1",
    kind: "camera_clip_ready" as const,
    resourceId: "home:ha:camera.entry",
    resourceName: "入户摄像头",
    areaName: "玄关",
    homeId: "primary-home",
    occurredAt: "2026-08-29T17:00:00+08:00",
    summary: "检测到有人移动，事件录像已保存。",
    artifactId: "artifact-1"
  };
  const record = buildXiaomiHomeEventRecord(event);
  assert.equal(record.adapterType, "xiaomiHome");
  assert.equal(record.sourceDeviceKind, "camera");
  assert.equal(record.sessionId, "primary-home");
  assert.deepEqual(xiaomiHomeEventTemplateValues(event), {
    xiaomiEventKind: "camera_clip_ready",
    xiaomiResourceId: "home:ha:camera.entry",
    xiaomiResourceName: "入户摄像头",
    xiaomiAreaName: "玄关",
    xiaomiHomeId: "primary-home",
    xiaomiArtifactId: "artifact-1"
  });
});

/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import type { XiaomiHomeRuntimeSettings, XiaomiHomeSettingsSnapshot } from "../../src/shared/xiaomiHomeSettingsContract";
import { xiaomiHomeSettingsClient } from "../src/xiaomiHomeSettingsClient";

const settings: XiaomiHomeRuntimeSettings = {
  baseUrl: "http://127.0.0.1:8123",
  tokenEnv: "RABIROUTE_XIAOMI_HOME_HA_TOKEN",
  requestTimeoutMs: 5000,
  writeEnabled: false,
  allowPublicBaseUrl: false,
  agentRoleId: "YeYu",
  eventMonitorEnabled: true,
  eventDeliveryMode: "significant",
  cameraMotionEntityIds: [],
  cameraClipCaptureEnabled: false,
  cameraClipAllowedHosts: [],
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  artifactReadTokenEnv: "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN",
  cameraClipRequestTimeoutMs: 10000,
  cameraClipMaxSegments: 120,
  cameraClipMaxSegmentBytes: 33554432
};
const snapshot: XiaomiHomeSettingsSnapshot = { schemaVersion: 1, source: "profile", revision: "revision-one", settings };

test("Xiaomi Home WebGUI saves through current /meta fencing and relative Manager APIs", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    if (String(input) === "/meta") {
      return new Response(JSON.stringify({ applicationGenerationId: "generation-current", managerInstanceId: "manager-current" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ code: 0, data: snapshot }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await xiaomiHomeSettingsClient.read(), snapshot);
    assert.deepEqual(await xiaomiHomeSettingsClient.update(snapshot, settings), snapshot);
    assert.deepEqual(requests.map(item => String(item.input)), [
      "/api/agent/xiaomi-home/settings",
      "/meta",
      "/api/agent/xiaomi-home/settings"
    ]);
    const headers = new Headers(requests[2]?.init?.headers);
    assert.equal(headers.get("x-rabiroute-expected-application-generation-id"), "generation-current");
    assert.equal(headers.get("x-rabiroute-expected-manager-instance-id"), "manager-current");
    assert.doesNotMatch(String(requests[2]?.init?.body), /access_token|Bearer /i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

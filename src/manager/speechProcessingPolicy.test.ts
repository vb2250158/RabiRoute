import assert from "node:assert/strict";
import test from "node:test";
import { ManagerSpeechControl } from "./speechControl.js";

test("transcribe streams save host ingress without Agent or persona writes, including forged upgrades", async () => {
  let deliveries = 0;
  let saved = 0;
  const runtime = { id: "record", kind: "asr", text: "transcript", source: "microphone", time: 1,
    processing_policy: "transcribe", route_profile_id: "profile", source_device_id: "phone",
    source_device_kind: "glasses", source_stream_id: "stream", message_adapter_type: "rabilink", segments: [] };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781", personas: () => [],
    routes: () => [{ id: "role", speechEnabled: true, rabiLinkEnabled: true, routeProfileIds: ["profile"] }],
    route: () => ({ id: "role", speechEnabled: true, rabiLinkEnabled: true, routeProfileIds: ["profile"] }),
    deliverTranscript: async () => { deliveries++; return { status: "delivered" }; },
    appendRouteLog: () => { throw new Error("must not write persona log"); },
    localSpeech: {
      inspect: async () => ({} as any), requestBinary: async () => ({} as any),
      requestJson: async (_url, path) => ({ status: 200, data: path.startsWith("/v1/records?") ? { data: [runtime] } : runtime })
    }
  });
  const command = { recordId: "record", text: "transcript", sourceDeviceId: "phone", sourceDeviceKind: "glasses",
    sourceStreamId: "stream", routeProfileId: "profile", messageAdapterType: "rabilink" as const };
  for (const processingPolicy of ["transcribe", "agent", undefined] as const) {
    const result = await control.acceptMessage({ ...command, processingPolicy });
    assert.equal(result.status, "recorded"); assert.equal(result.reason, "transcribe_only");
    assert.deepEqual(result.deliveries, []); saved++;
  }
  assert.equal(saved, 3); assert.equal(deliveries, 0);
  await assert.rejects(control.acceptMessage({ ...command, sourceDeviceId: "spoof", processingPolicy: "transcribe" }));
  await assert.rejects(control.acceptMessage({ ...command, sourceDeviceId: "spoof", processingPolicy: "agent" }));
  await assert.rejects(control.acceptMessage({ ...command, sourceDeviceId: "spoof" }));
});

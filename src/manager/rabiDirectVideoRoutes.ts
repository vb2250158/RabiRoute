import { DIRECT_VIDEO_CHANNEL, DIRECT_VIDEO_DEVICE_ID_PATTERN, DIRECT_VIDEO_LIMITS, DIRECT_VIDEO_OFFER_FIELDS, RabiDirectVideo } from "./rabiDirectVideo.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";
import type { ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";

const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const errorSchema = { type: "object", required: ["error"], additionalProperties: true, properties: { error: { type: "string" } } } as const;
const readOnlyResult = () => ({ status: 403, body: errorResponsePresentation({ error: "Read-only Manager cannot start video." }, 403) });

/** HTTP negotiates SDP only; the original receiver owns WebRTC sessions, files and shutdown. */
export function createDirectVideoOperations(receiver: RabiDirectVideo, readOnly: boolean): readonly ApiOperationDefinition[] {
  const negotiate = async (input: ApiOperationInput) => {
    if (readOnly) return readOnlyResult();
    try { input.signal?.throwIfAborted(); const answer = await receiver.offer(input.body);
      if (!receiver.isSessionActive(answer.sessionId)) throw new Error("The original video session closed before answer disclosure.");
      return { status: 200, body: answer }; }
    catch { return { status: 400, body: errorResponsePresentation({ error: "Video negotiation failed; check direct connectivity, session capacity and SDP." }, 400) }; }
  };
  return [{ contract: { operationId: "manager.rabilink.video.status", contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/rabilink/video/status", exposure: "public", transport: "http",
    description: "Read native direct-video session state; camera bytes never pass through this HTTP operation or Relay.",
    request: { path: empty, query: ignored, headers: ignored, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["sessions", "relay"], additionalProperties: false, properties: {
      relay: { const: false }, sessions: { type: "array", items: { type: "object", required: ["id", "deviceId", "bytes", "state", "relay"], additionalProperties: false,
        properties: { id: { type: "string" }, deviceId: { type: "string" }, bytes: { type: "integer", minimum: 0 }, state: { type: "string" }, relay: { const: false } } } }
    } } } }, effects: { mode: "read", description: "Read the original receiver map; closing sessions remain visible until native socket and file cleanup finishes." },
    recovery: { strategy: "repeatable-read", description: "Read the same active-session state. Closed sessions disappear; absence does not prove a preceding negotiation never ran." },
    validators: [{ id: "direct-video-native-status", description: "Preserve native session identity, received-byte count, free-form native closing state and relay=false; ignore unknown query fields." }]
  }, handler: () => ({ status: 200, body: { sessions: receiver.status(), relay: false } }) },
  { contract: { operationId: "manager.rabilink.video.offer", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/rabilink/video/offer", exposure: "public", transport: "http",
    description: "Negotiate the original direct WebRTC receiver using SDP and deviceId only. HTTP acceptance does not prove camera capture, file completion or playback.",
    request: { path: empty, query: ignored, headers: ignored, body: { kind: "json", maxBytes: DIRECT_VIDEO_LIMITS.signalBytes, allowAnyContentType: true, schema: {
      type: "object", required: DIRECT_VIDEO_OFFER_FIELDS, additionalProperties: false, properties: { deviceId: { type: "string", pattern: DIRECT_VIDEO_DEVICE_ID_PATTERN }, sdp: { type: "string", description: `Native SDP validation: at most ${DIRECT_VIDEO_LIMITS.sdpBytes} UTF-8 bytes; starts with v=0, contains m=application, and has no audio/video media lines or relay candidate.` } }
    } } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["sessionId", "type", "sdp", "relay"], additionalProperties: false, properties: { sessionId: { type: "string" }, type: { const: "answer" }, sdp: { type: "string" }, relay: { const: false } } } }, "400": { mediaType: "application/json", schema: errorSchema }, "403": { mediaType: "application/json", schema: errorSchema } },
    effects: { mode: "webrtc-negotiation", description: `May allocate one of ${DIRECT_VIDEO_LIMITS.sessions} native sessions. Media uses ordered reliable ${DIRECT_VIDEO_CHANNEL} DTLS/SCTP, with ${DIRECT_VIDEO_LIMITS.frameBytes}-byte chunks and a ${receiver.maxBytes}-byte per-session budget, stored by the original receiver. Relay carries signalling only.` },
    recovery: { strategy: "inspect-native-session-no-replay", receiptPath: "/api/rabilink/video/status", description: "There is no request-level idempotency. Retain deviceId and returned sessionId, inspect native sessions and do not automatically repeat an uncertain offer. HTTP disconnection does not transfer or end the native media session; the receiver's original timeout/close rules and plugin shutdown own it." },
    validators: [{ id: "direct-video-native-offer", description: `The original offer validator and Werift own SDP, direct connectivity, duplicate devices and capacity. Connection timeout ${DIRECT_VIDEO_LIMITS.connectionMs}ms, media idle timeout ${DIRECT_VIDEO_LIMITS.idleMs}ms. Read-only mode rejects before body consumption; authenticated remote connections need no extra grant. Original admission is checked before answer disclosure.` }]
  }, prepare: () => readOnly ? readOnlyResult() : negotiate, handler: negotiate }];
}

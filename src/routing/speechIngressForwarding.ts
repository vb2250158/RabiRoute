import type { VoiceTranscriptEventRecord } from "../history.js";
import {
  speechIngressDisplayText,
  speechIngressSingleSpeakerMetadata
} from "../speechIngressStore.js";
import type { SpeechIngressRecord } from "../shared/speechControlContract.js";
import type { ForwardRouteKind } from "./types.js";

export type SpeechIngressForwarding = {
  routeKind: Extract<ForwardRouteKind, "voice_transcript" | "rabilink">;
  record: VoiceTranscriptEventRecord;
};

export type SpeechIngressForwardingOptions = {
  gatewayId?: string;
  routeProfileId?: string;
};

function optionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * Convert the host-owned speech ingress evidence into the canonical Route event.
 * Keep this mapping shared by the CLI delivery boundary and regression tests so
 * mobile/PC speech cannot silently lose source or voiceprint fields in transit.
 */
export function createSpeechIngressForwarding(
  ingress: SpeechIngressRecord,
  options: SpeechIngressForwardingOptions = {}
): SpeechIngressForwarding {
  const adapterType = ingress.messageAdapterType;
  const routeKind = adapterType === "rabilink" ? "rabilink" : "voice_transcript";
  const record: VoiceTranscriptEventRecord = {
    time: ingress.time,
    rawMessage: speechIngressDisplayText(ingress),
    messageId: ingress.id,
    senderName: adapterType === "rabilink"
      ? "RabiLink 手机音频流"
      : ingress.segments.length > 1 ? "RabiPC 多人语音" : "RabiPC 语音消息端",
    adapterType,
    gatewayId: optionalText(options.gatewayId),
    source: ingress.source,
    transport: ingress.transport,
    channelType: ingress.channelType,
    messageAdapterType: ingress.messageAdapterType,
    sessionId: ingress.sessionId,
    provider: ingress.provider,
    model: ingress.model,
    language: ingress.language,
    sampleRate: ingress.sampleRate,
    audioFormat: ingress.audioFormat,
    channels: ingress.channels,
    ingestedAt: ingress.ingestedAt,
    durationSeconds: ingress.duration,
    peak: ingress.peak,
    rms: ingress.rms,
    sourceDeviceId: ingress.sourceDeviceId,
    sourceDeviceName: ingress.sourceDeviceName,
    sourceDeviceKind: ingress.sourceDeviceKind,
    sourceStreamId: ingress.sourceStreamId,
    sourceHostId: ingress.sourceHostId,
    sourceHostName: ingress.sourceHostName,
    startedAt: ingress.startedAt,
    endedAt: ingress.completedAt,
    segments: ingress.segments,
    ...speechIngressSingleSpeakerMetadata(ingress),
    routeProfileId: optionalText(options.routeProfileId) || ingress.routeProfileId
  };
  return { routeKind, record };
}

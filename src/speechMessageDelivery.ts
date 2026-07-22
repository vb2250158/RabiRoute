import type { ForwardDeliveryResult } from "./forwarding.js";
import type { SpeechMessageStatus } from "./shared/speechControlContract.js";
import fs from "node:fs";

export const SPEECH_PROCESS_RESULT_MARKER = "RABIROUTE_SPEECH_RESULT ";
export const SPEECH_EXIT_DELIVERED = 0;
export const SPEECH_EXIT_FAILED = 1;
export const SPEECH_EXIT_NOT_DELIVERED = 2;
export const SPEECH_EXIT_RECORDED = 3;

export type SpeechDeliveryExitCode =
  | typeof SPEECH_EXIT_DELIVERED
  | typeof SPEECH_EXIT_FAILED
  | typeof SPEECH_EXIT_NOT_DELIVERED
  | typeof SPEECH_EXIT_RECORDED;

export type SpeechProcessResult = {
  status: SpeechMessageStatus;
  reason?: string;
  detail?: string;
};

export type SpeechProcessOutcome = {
  exitCode: SpeechDeliveryExitCode;
  result: SpeechProcessResult;
};

function deliveryDetail(result: ForwardDeliveryResult): string {
  const delivered = result.adapterOutcomes.filter((item) => item.status === "delivered").length;
  const failed = result.adapterOutcomes.filter((item) => item.status === "failed").length;
  return `status=${result.status} matched=${result.matchedRuleCount} packets=${result.sentPacketCount} adapters=${delivered}/${result.adapterOutcomes.length} failed=${failed}`;
}

export function speechForwardProcessOutcome(result: ForwardDeliveryResult): SpeechProcessOutcome {
  if (result.status === "delivered") {
    return {
      exitCode: SPEECH_EXIT_DELIVERED,
      result: { status: "delivered", detail: deliveryDetail(result) }
    };
  }
  const failed = result.status === "failed";
  return {
    exitCode: failed ? SPEECH_EXIT_FAILED : SPEECH_EXIT_NOT_DELIVERED,
    result: {
      status: "failed",
      reason: result.reason || result.status,
      detail: deliveryDetail(result)
    }
  };
}

export function speechRecordedProcessOutcome(recordedRoutes: number, reason: string): SpeechProcessOutcome {
  if (recordedRoutes > 0) {
    return {
      exitCode: SPEECH_EXIT_RECORDED,
      result: {
        status: "recorded",
        reason,
        detail: `Transcript recorded in ${recordedRoutes} persona conversation ledger(s) without Agent delivery.`
      }
    };
  }
  return {
    exitCode: SPEECH_EXIT_NOT_DELIVERED,
    result: {
      status: "failed",
      reason: "no_active_route_profile",
      detail: "Transcript was not delivered and no persona conversation ledger accepted the record."
    }
  };
}

export function formatSpeechProcessResult(result: SpeechProcessResult): string {
  return `${SPEECH_PROCESS_RESULT_MARKER}${JSON.stringify(result)}`;
}

/** The CLI exits immediately after this receipt, so write synchronously to avoid losing it in a pipe buffer. */
export function writeSpeechProcessResult(result: SpeechProcessResult): void {
  fs.writeSync(process.stdout.fd, `${formatSpeechProcessResult(result)}\n`, undefined, "utf8");
}

export function parseSpeechProcessResult(output: string): SpeechProcessResult | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith(SPEECH_PROCESS_RESULT_MARKER)) continue;
    try {
      const parsed = JSON.parse(line.slice(SPEECH_PROCESS_RESULT_MARKER.length)) as Partial<SpeechProcessResult>;
      if (parsed.status !== "delivered" && parsed.status !== "recorded" && parsed.status !== "failed") return undefined;
      return {
        status: parsed.status,
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined,
        detail: typeof parsed.detail === "string" && parsed.detail.trim() ? parsed.detail.trim() : undefined
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

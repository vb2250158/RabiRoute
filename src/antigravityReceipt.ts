import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Antigravity transcript receipts.
 *
 * The host appends every inbound prompt and every model reply to a per-conversation
 * JSONL log. That log is durable and locally readable, so a delivery whose
 * acceptance was lost can be reconstructed after the fact instead of being
 * reported as an unprovable `in_progress`.
 *
 * File shape:
 *   ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
 *
 * One JSON object per line, e.g.
 *   {"step_index":4,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE",...}
 */

export type AntigravityTranscriptStep = {
  stepIndex: number;
  source: string;
  type: string;
  status: string;
  createdAt: string;
  content: string;
};

export type AntigravityReceiptOptions = {
  /** Text to look for. Matched against the first 30 characters. */
  needle: string;
  /** Step count observed before delivery, when known. */
  initialNumSteps?: number;
  timeoutMs?: number;
  intervalMs?: number;
};

export type AntigravityReceipt = {
  found: boolean;
  stepIndex: number | null;
  source: string | null;
  totalSteps: number;
  /** True once a completed model turn follows the matched prompt. */
  modelReplied: boolean;
  modelText: string | null;
  reason: string;
};

const RECEIPT_MATCH_CHARS = 30;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_INTERVAL_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Root of the Antigravity desktop app's conversation data. */
export function antigravityBrainRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  const dataHome = env.ANTIGRAVITY_DATA_HOME?.trim();
  if (dataHome) return path.join(dataHome, "brain");
  return path.join(home, ".gemini", "antigravity", "brain");
}

/** Absolute path of a conversation's transcript log. */
export function antigravityTranscriptPath(
  conversationId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(
    antigravityBrainRoot(env),
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl"
  );
}

/**
 * Parse the transcript log into steps. Malformed lines are skipped rather than
 * failing the read, because the host may append while this runs.
 */
export function readAntigravityTranscript(
  conversationId: string,
  env: NodeJS.ProcessEnv = process.env
): AntigravityTranscriptStep[] | null {
  const transcriptPath = antigravityTranscriptPath(conversationId, env);
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const steps: AntigravityTranscriptStep[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    steps.push({
      stepIndex: typeof record.step_index === "number" ? record.step_index : steps.length,
      source: typeof record.source === "string" ? record.source : "",
      type: typeof record.type === "string" ? record.type : "",
      status: typeof record.status === "string" ? record.status : "",
      createdAt: typeof record.created_at === "string" ? record.created_at : "",
      content: typeof record.content === "string" ? record.content : ""
    });
  }
  return steps;
}

function findPromptStep(
  steps: AntigravityTranscriptStep[],
  needle: string
): AntigravityTranscriptStep | null {
  const probe = needle.slice(0, RECEIPT_MATCH_CHARS);
  if (!probe) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.type !== "USER_INPUT" && step.type !== "SYSTEM_MESSAGE") continue;
    if (step.content.includes(probe)) return step;
  }
  return null;
}

function findModelReply(
  steps: AntigravityTranscriptStep[],
  afterIndex: number
): AntigravityTranscriptStep | null {
  for (const step of steps) {
    if (step.stepIndex <= afterIndex) continue;
    if (step.source === "MODEL" && step.status === "DONE") return step;
  }
  return null;
}

/**
 * Read a delivery receipt for `needle`, polling until it appears or the timeout
 * elapses. Returns `found: false` with a reason instead of throwing, so callers
 * can record an explicit unproven state.
 */
export async function readAntigravityReceipt(
  conversationId: string,
  options: AntigravityReceiptOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<AntigravityReceipt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastTotal = 0;

  for (;;) {
    const steps = readAntigravityTranscript(conversationId, env);
    if (steps) {
      lastTotal = steps.length;
      const promptStep = findPromptStep(steps, options.needle);
      // Guard against matching a prior delivery of the same text.
      const isNew = options.initialNumSteps === undefined
        || promptStep === null
        || promptStep.stepIndex >= options.initialNumSteps;
      if (promptStep && isNew) {
        const reply = findModelReply(steps, promptStep.stepIndex);
        return {
          found: true,
          stepIndex: promptStep.stepIndex,
          source: promptStep.source,
          totalSteps: steps.length,
          modelReplied: Boolean(reply),
          modelText: reply ? reply.content.slice(0, 200) : null,
          reason: reply
            ? `step ${promptStep.stepIndex} recorded (${promptStep.source}); model replied`
            : `step ${promptStep.stepIndex} recorded (${promptStep.source}); model reply pending`
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  return {
    found: false,
    stepIndex: null,
    source: null,
    totalSteps: lastTotal,
    modelReplied: false,
    modelText: null,
    reason: lastTotal
      ? `No matching prompt appeared within ${timeoutMs}ms (transcript has ${lastTotal} steps)`
      : `No transcript was readable for conversation ${conversationId}`
  };
}

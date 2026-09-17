import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { appendAdapterLog } from "./history.js";
import {
  deliverAntigravityPrompt,
  resolveAntigravityEnvironment,
  type AntigravityEnvironment
} from "./antigravityBridge.js";
import {
  readAntigravityReceipt,
  readAntigravityTranscript,
  type AntigravityReceipt
} from "./antigravityReceipt.js";

/**
 * Antigravity delivery runtime.
 *
 * Mirrors the Codex runtime's shape: deliveries are serialized through a single
 * queue so two prompts cannot interleave inside one conversation, and each
 * delivery records an explicit lifecycle state (`accepted` -> `delivered` /
 * `failed`) rather than leaving the caller to infer one.
 *
 * Delivery itself is delegated to `antigravityBridge`, which shells out to the
 * host's own `agy agentapi` subcommands.
 */

export type AntigravityDeliveryStatus = "accepted" | "delivered" | "failed";

export type AntigravityDeliveryRecord = {
  deliveryId: string;
  conversationId: string;
  status: AntigravityDeliveryStatus;
  acceptedAt: string;
  deliveredAt?: string;
  failedAt?: string;
  error?: string;
  /** Receipt read back from the transcript log, when it could be read. */
  receipt?: AntigravityReceipt;
};

export type AntigravityMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
};

export type AntigravityBridgeDependencies = {
  resolveEnvironment?: () => Promise<AntigravityEnvironment>;
  deliverPrompt?: typeof deliverAntigravityPrompt;
  readReceipt?: typeof readAntigravityReceipt;
  readTranscript?: typeof readAntigravityTranscript;
  now?: () => Date;
};

const deliveryLog: AntigravityDeliveryRecord[] = [];
const MAX_LOGGED_DELIVERIES = 100;

let notificationQueue: Promise<unknown> = Promise.resolve();

type ResolvedDependencies = {
  resolveEnvironment: () => Promise<AntigravityEnvironment>;
  deliverPrompt: typeof deliverAntigravityPrompt;
  readReceipt: typeof readAntigravityReceipt;
  readTranscript: typeof readAntigravityTranscript;
  now: () => Date;
};

function resolveDependencies(dependencies: AntigravityBridgeDependencies = {}): ResolvedDependencies {
  return {
    resolveEnvironment: dependencies.resolveEnvironment ?? resolveAntigravityEnvironment,
    deliverPrompt: dependencies.deliverPrompt ?? deliverAntigravityPrompt,
    readReceipt: dependencies.readReceipt ?? readAntigravityReceipt,
    readTranscript: dependencies.readTranscript ?? readAntigravityTranscript,
    now: dependencies.now ?? (() => new Date())
  };
}

function recordDelivery(record: AntigravityDeliveryRecord): void {
  deliveryLog.push(record);
  if (deliveryLog.length > MAX_LOGGED_DELIVERIES) {
    deliveryLog.splice(0, deliveryLog.length - MAX_LOGGED_DELIVERIES);
  }
  appendAdapterLog("antigravity", {
    event: `delivery_${record.status}`,
    level: record.status === "failed" ? "error" : "info",
    message: `delivery ${record.status}`,
    data: {
      deliveryId: record.deliveryId,
      conversationId: record.conversationId,
      ...(record.error ? { error: record.error } : {}),
      ...(record.receipt ? { receipt: record.receipt } : {})
    }
  });
}

/** Recent delivery records, newest last. Intended for diagnostics and tests. */
export function listAntigravityDeliveries(): AntigravityDeliveryRecord[] {
  return [...deliveryLog];
}

/** Reset the in-memory delivery log. Intended for tests. */
export function resetAntigravityDeliveriesForTest(): void {
  deliveryLog.length = 0;
  notificationQueue = Promise.resolve();
}

/** Configured conversation to deliver into, when one is set. */
function configuredConversationId(): string | undefined {
  const fromConfig = config.antigravityConversationId;
  const trimmed = typeof fromConfig === "string" ? fromConfig.trim() : "";
  return trimmed || undefined;
}

export type AntigravityNotifyResult = {
  thread: AntigravityMonitorThread;
  record: AntigravityDeliveryRecord;
};

/**
 * Deliver a prompt into Antigravity and record the delivery lifecycle.
 *
 * When a conversation is configured the prompt is posted into it as a system
 * message; otherwise a new conversation is started. That keeps the configured
 * session stable across deliveries instead of spawning a new one per message.
 */
async function deliverAntigravityNotification(
  message: string,
  dependencies: AntigravityBridgeDependencies
): Promise<AntigravityNotifyResult> {
  const resolved = resolveDependencies(dependencies);
  const deliveryId = randomUUID();
  const acceptedAt = resolved.now().toISOString();
  const conversationId = configuredConversationId();

  const record: AntigravityDeliveryRecord = {
    deliveryId,
    conversationId: conversationId ?? "",
    status: "accepted",
    acceptedAt
  };

  try {
    const environment = await resolved.resolveEnvironment();

    // Capture the pre-delivery step count so the receipt cannot match an earlier
    // delivery of identical text.
    const initialNumSteps = conversationId
      ? resolved.readTranscript(conversationId)?.length
      : undefined;

    const result = await resolved.deliverPrompt(
      conversationId
        ? { prompt: message, conversationId, kind: "system-message" }
        : { prompt: message, kind: "new-conversation" },
      environment
    );

    record.conversationId = result.conversationId;
    record.deliveredAt = resolved.now().toISOString();

    const receipt = await resolved.readReceipt(result.conversationId, {
      needle: message,
      ...(initialNumSteps === undefined ? {} : { initialNumSteps })
    }).catch(() => null);
    if (receipt) record.receipt = receipt;

    record.status = "delivered";
    recordDelivery(record);

    return {
      thread: {
        id: result.conversationId,
        threadName: conversationId ? "Antigravity conversation" : "Antigravity new conversation",
        updatedAt: record.deliveredAt,
        source: "Antigravity agentapi"
      },
      record
    };
  } catch (error) {
    record.status = "failed";
    record.failedAt = resolved.now().toISOString();
    record.error = error instanceof Error ? error.message : String(error);
    recordDelivery(record);
    throw error;
  }
}

/**
 * Queue a delivery. Calls are serialized so concurrent notifications cannot
 * interleave inside one conversation.
 */
export function notifyAntigravity(
  message: string,
  dependencies: AntigravityBridgeDependencies = {}
): Promise<AntigravityNotifyResult> {
  const result = notificationQueue
    .catch(() => undefined)
    .then(() => deliverAntigravityNotification(message, dependencies));
  notificationQueue = result.catch(() => undefined);
  return result;
}

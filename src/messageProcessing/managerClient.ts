import type { MessageProcessingSource } from "./board.js";

export type MessageProcessingManagerCommand =
  | {
      action: "register_group";
      requirementId: string;
      messageGroupId: string;
      source: MessageProcessingSource;
    }
  | {
      action: "dispatch";
      requirementId: string;
      worker: {
        threadId: string;
        threadName: string;
        workspace: string;
      };
    }
  | {
      action: "dispatch_failed";
      requirementId: string;
      error: string;
    };

export async function sendMessageProcessingManagerCommand(
  managerBaseUrl: string,
  command: MessageProcessingManagerCommand,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const target = new URL("/api/message-processing/requirements", `${managerBaseUrl.replace(/\/+$/, "")}/`);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported Manager protocol: ${target.protocol}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(command),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.code === -1) {
      throw new Error(String(body.message || `Manager returned HTTP ${response.status}.`));
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Manager message-processing request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

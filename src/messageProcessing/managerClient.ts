import type { MessageProcessingSource } from "./board.js";
import type { MessageAgentReferencedSender } from "./referencedAgentSender.js";

export type ReferencedAgentSenderQuery = {
  channel: string;
  sentMessageId: string;
  routeId?: string;
};

export async function findReferencedAgentSenders(
  managerBaseUrl: string,
  query: ReferencedAgentSenderQuery,
  timeoutMs = 5_000
): Promise<MessageAgentReferencedSender[]> {
  const target = new URL("/api/agent/send/traces", `${managerBaseUrl.replace(/\/+$/, "")}/`);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported Manager protocol: ${target.protocol}`);
  }
  target.searchParams.set("channel", String(query.channel || "").trim());
  target.searchParams.set("sentMessageId", String(query.sentMessageId || "").trim());
  if (String(query.routeId || "").trim()) target.searchParams.set("routeId", String(query.routeId).trim());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(target, { method: "GET", signal: controller.signal });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.code === -1) {
      throw new Error(String(body.message || `Manager returned HTTP ${response.status}.`));
    }
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : {};
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const senders = new Map<string, MessageAgentReferencedSender>();
    for (const value of matches) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const match = value as Record<string, unknown>;
      const result = match.result && typeof match.result === "object" && !Array.isArray(match.result)
        ? match.result as Record<string, unknown>
        : {};
      const sender = result.sender && typeof result.sender === "object" && !Array.isArray(result.sender)
        ? result.sender as Record<string, unknown>
        : {};
      const agentType = String(sender.agentType || "").trim();
      const sessionId = String(sender.sessionId || "").trim();
      if (!agentType || !sessionId) continue;
      const key = `${agentType}\u0000${sessionId}`;
      if (!senders.has(key)) {
        senders.set(key, {
          deliveryId: String(match.deliveryId || "").trim() || undefined,
          agentType,
          sessionId
        });
      }
    }
    return [...senders.values()];
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Manager Agent-send trace request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

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

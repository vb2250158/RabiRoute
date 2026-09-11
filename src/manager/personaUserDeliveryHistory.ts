import type { PlanFeedbackRecord } from "../planFeedback.js";
import type { AgentThreadRequestResult } from "../agentThreads.js";
import { appendPersonaChatReply } from "../personaChatHistory.js";

/** Called after an actual user-feedback delivery attempt, never on save-only submissions. */
export async function recordPersonaUserDelivery(
  roleDir: string,
  feedback: PlanFeedbackRecord,
  result: AgentThreadRequestResult,
  changed: () => void
): Promise<void> {
  if (feedback.author !== "user" || feedback.deliveryStatus === "record_only") return;
  const delivery = result.data.delivery as { deliveryId?: string; status?: string } | undefined;
  const target = String(result.data.threadId || "");
  if (!target || !delivery?.deliveryId || !["delivered", "unconfirmed"].includes(delivery.status || "")) return;
  const thread = result.data.thread as { title?: string } | undefined;
  const attachments = [...feedback.attachments, ...feedback.planAttachments];
  const text = [feedback.text, ...attachments.map(attachment => `- ${attachment.name}`)].filter(Boolean).join("\n\n");
  const added = await appendPersonaChatReply(roleDir, {
    kind: "user_delivery", sessionId: feedback.source, sourceLabel: feedback.source,
    targetSessionId: target, targetSessionTitle: thread?.title,
    // Feedback identity remains stable through transport retries and receipt recovery.
    deliveryId: delivery.deliveryId,
    deliveryStatus: delivery.status === "delivered" ? "delivered" : "unconfirmed",
    planId: feedback.planId, planTitle: feedback.planTitle, feedbackId: feedback.id, text
  });
  if (added) changed();
}

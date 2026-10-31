import type { RolePanelTimelineAppendResult } from "../rolePanelTimeline.js";

/** Notify displays only after the timeline owner has committed an assistant reply. */
export function notifyRolePanelMessage(
  result: RolePanelTimelineAppendResult,
  publish: (event: string, data: unknown) => void
): void {
  const { message, appended } = result;
  if (!appended || message.direction !== "assistant" || message.status !== "sent" || !message.text.trim()) return;
  publish("role_panel_message", { roleId: message.roleId, messageId: message.id, text: message.text });
}

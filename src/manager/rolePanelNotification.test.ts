import assert from "node:assert/strict";
import test from "node:test";
import { notifyRolePanelMessage } from "./rolePanelNotification.js";
import type { RolePanelTimelineMessage } from "../rolePanelTimeline.js";

test("only newly committed sent assistant text becomes a persona notification", () => {
  const message: RolePanelTimelineMessage = { id: "reply-1", roleId: "example", time: 1,
    direction: "assistant", sender: "agent", text: "Exact delivered text\nSecond line", attachments: [], status: "sent" };
  const events: unknown[] = [];
  const publish = (event: string, data: unknown) => events.push({ event, data });
  notifyRolePanelMessage({ appended: true, message }, publish);
  assert.deepEqual(events, [{ event: "role_panel_message", data: {
    roleId: "example", messageId: "reply-1", text: message.text } }]);
  notifyRolePanelMessage({ appended: false, message }, publish);
  for (const direction of ["user", "system"] as const)
    notifyRolePanelMessage({ appended: true, message: { ...message, direction } }, publish);
  for (const status of ["pending", "failed", "draft"] as const)
    notifyRolePanelMessage({ appended: true, message: { ...message, status } }, publish);
  notifyRolePanelMessage({ appended: true, message: { ...message, text: "  " } }, publish);
  assert.equal(events.length, 1);
});

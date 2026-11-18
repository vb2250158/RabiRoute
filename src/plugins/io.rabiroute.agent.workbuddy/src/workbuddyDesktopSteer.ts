import { normalizeWorkbuddyWorkspace } from "./workbuddySessionStore.js";

export type WorkbuddyDesktopMessageInput = {
  threadId: string;
  workspace: string;
  text: string;
  deliveryId: string;
};

export type WorkbuddyDesktopMessageResult = {
  state: "accepted" | "unavailable" | "inactive" | "unknown";
  threadId: string;
  deliveryId: string;
};

export type WorkbuddyDesktopMessageMode = "steer" | "continue";

/** Use the desktop’s native send operation with the requested queue behavior. */
export function workbuddyDesktopMessageExpression(input: WorkbuddyDesktopMessageInput, mode: WorkbuddyDesktopMessageMode = "steer"): string {
  return `(async () => {
    const { threadId, workspace, text, deliveryId } = ${JSON.stringify(input)};
    const steer = ${mode === "steer"};
    const reply = state => ({ state, threadId, deliveryId });
    const workspaceKey = (${normalizeWorkbuddyWorkspace.toString()});
    const conversations = window.wb?.conversations;
    if (typeof conversations?.get !== 'function') return reply('unavailable');
    const thread = await conversations.get(threadId);
    if (thread?.info?.id !== threadId || thread.info.transport !== 'local'
      || workspaceKey(thread.info.space?.cwd) !== workspaceKey(workspace)
      || typeof thread.sendPrompt !== 'function') return reply('unavailable');
    if (steer && thread.info.state !== 'planning' && thread.info.state !== 'working') return reply('inactive');
    const result = await thread.sendPrompt([{ type: 'text', text }], {
      clientRequestId: deliveryId, clientTimestamp: Date.now(),
      emitUserMessage: true, _expectQueueReceipt: true, ...(steer ? { queueDelivery: 'steer' } : {})
    });
    const queued = result?.disposition === 'queued' && typeof result.item?.id === 'string' && result.item.id.trim()
      && (result.item.clientRequestId == null || result.item.clientRequestId === deliveryId);
    return reply(queued ? 'accepted' : 'unknown');
  })()`;
}

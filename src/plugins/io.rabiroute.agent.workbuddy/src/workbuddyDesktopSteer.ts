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
export type WorkbuddyDesktopContinuationReadiness = "ready" | "loading" | "unavailable";

const desktopConversationLookup = `
    const workspaceKey = (${normalizeWorkbuddyWorkspace.toString()});
    const expectedWorkspace = workspaceKey(workspace);
    const conversations = window.wb?.conversations;
    const thread = typeof conversations?.get === 'function' ? await conversations.get(threadId) : undefined;
    const info = thread?.info;
    const actualWorkspace = workspaceKey(info?.space?.cwd);
    let readiness = 'loading';
    if (!expectedWorkspace || (info?.id && info.id !== threadId)
      || (info?.transport && info.transport !== 'local') || (actualWorkspace && actualWorkspace !== expectedWorkspace)) {
      readiness = 'unavailable';
    } else if (info?.id === threadId && info.transport === 'local' && actualWorkspace && typeof thread.sendPrompt === 'function') {
      readiness = 'ready';
    }`;

/** The desktop lookup loads the original owner's view without submitting a prompt. */
export function workbuddyDesktopContinuationReadinessExpression({ threadId, workspace }: Pick<WorkbuddyDesktopMessageInput, "threadId" | "workspace">): string {
  return `(async () => {
    const { threadId, workspace } = ${JSON.stringify({ threadId, workspace })};
    ${desktopConversationLookup}
    return readiness;
  })()`;
}

/** Use the desktop’s native send operation with the requested queue behavior. */
export function workbuddyDesktopMessageExpression(input: WorkbuddyDesktopMessageInput, mode: WorkbuddyDesktopMessageMode = "steer"): string {
  return `(async () => {
    const { threadId, workspace, text, deliveryId } = ${JSON.stringify(input)};
    const steer = ${mode === "steer"};
    const reply = state => ({ state, threadId, deliveryId });
    ${desktopConversationLookup}
    if (readiness !== 'ready') return reply('unavailable');
    if (steer && info.state !== 'planning' && info.state !== 'working') return reply('inactive');
    const result = await thread.sendPrompt([{ type: 'text', text }], {
      clientRequestId: deliveryId, clientTimestamp: Date.now(),
      emitUserMessage: true, _expectQueueReceipt: true, ...(steer ? { queueDelivery: 'steer' } : {})
    });
    const queued = result?.disposition === 'queued' && typeof result.item?.id === 'string' && result.item.id.trim()
      && (result.item.clientRequestId == null || result.item.clientRequestId === deliveryId);
    return reply(queued ? 'accepted' : 'unknown');
  })()`;
}

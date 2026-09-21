/**
 * WorkBuddy tasks on the Agent thread bridge.
 *
 * The bridge addresses one session by id, so this module projects WorkBuddy's
 * per-task surface into the shapes the bridge expects: listing and reading come
 * from the task database plus the live session descriptors, and delivery stays
 * on the single real message path in `workbuddySessionBridge.ts`. No second
 * transport is introduced here — the gateway remains the only writer.
 *
 * WorkBuddy tasks have no create or rename surface: a task is created inside the
 * desktop app, and its title is owned there. The bridge treats those actions as
 * unsupported for this adapter, which is why they are deliberately absent.
 */
import {
  deliverWorkbuddyMessage,
  ensureWorkbuddyDeliverable,
  type WorkbuddyPrimaryBinding
} from "./workbuddySessionBridge.js";
import {
  listWorkbuddyTasks,
  normalizeWorkbuddyWorkspace,
  readWorkbuddyTask,
  type WorkbuddyTask
} from "./workbuddySessionStore.js";
import type { AgentThreadSummary } from "./agentThreads.js";

/** Project one task onto the bridge's summary shape. */
function toThreadSummary(task: WorkbuddyTask): AgentThreadSummary {
  return {
    id: task.id,
    title: task.name || task.autoTitle || task.id,
    updatedAt: task.updatedAt,
    cwd: task.workspace,
    archived: task.archived
  };
}

/**
 * List WorkBuddy tasks for the bridge.
 * @param params - bridge listing parameters; `allowedWorkspaces` filters by task workspace.
 * @returns one summary per task, newest first as the task store returns them.
 */
export function listWorkbuddyThreads(params: {
  query: string;
  limit: number;
  offset: number;
  allowedWorkspaces: string[];
}): AgentThreadSummary[] {
  return listWorkbuddyTasks({
    query: params.query,
    limit: params.limit,
    offset: params.offset,
    allowedWorkspaces: params.allowedWorkspaces
  }).map(toThreadSummary);
}

/**
 * Read one WorkBuddy task for the bridge.
 *
 * The returned object carries `id` and `title` so the bridge can derive a
 * summary, plus the live-session fields callers need to tell an addressable task
 * from one whose owner process has exited.
 * @param threadId - WorkBuddy task id.
 * @returns the task projection; throws when the id matches no task.
 */
export function readWorkbuddyThread(threadId: string): unknown {
  const task = readWorkbuddyTask(threadId);
  if (!task) throw new Error(`WorkBuddy task ${threadId} was not found.`);
  return {
    ...toThreadSummary(task),
    status: task.status,
    model: task.model,
    live: task.live
  };
}

/**
 * Deliver one prompt into a WorkBuddy task through the session gateway.
 *
 * The workspace comes from the task rather than from the caller: a task runs in
 * exactly one directory, so a caller-supplied mismatch is a request error
 * instead of something to silently reconcile. A task without a live session
 * process fails closed in `ensureWorkbuddyDeliverable` — nothing here starts a
 * replacement runtime.
 * @param params - target task, prompt text, and the caller's expected workspace.
 * @returns the delivery receipt the bridge records for this transport.
 */
export async function sendWorkbuddyThreadMessage(params: {
  threadId: string;
  prompt: string;
  cwd: string;
}): Promise<{
  threadId: string;
  action: "started";
  openedThread: boolean;
  transport: "http";
}> {
  const task = readWorkbuddyTask(params.threadId);
  if (!task) throw new Error(`WorkBuddy task ${params.threadId} was not found.`);
  const requestedWorkspace = params.cwd.trim();
  if (requestedWorkspace
    && normalizeWorkbuddyWorkspace(requestedWorkspace) !== normalizeWorkbuddyWorkspace(task.workspace)) {
    throw new Error(
      `WorkBuddy task ${task.id} runs in ${task.workspace}, so it cannot accept a delivery for ${requestedWorkspace}.`
    );
  }
  const binding: WorkbuddyPrimaryBinding = {
    sessionId: task.id,
    sessionName: task.name,
    cwd: task.workspace,
    endpoint: ""
  };
  const { task: resolved, endpoint } = ensureWorkbuddyDeliverable(binding);
  await deliverWorkbuddyMessage({
    sessionId: resolved.id,
    text: params.prompt,
    endpoint
  });
  return { threadId: resolved.id, action: "started", openedThread: false, transport: "http" };
}

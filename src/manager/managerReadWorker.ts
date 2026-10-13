import { parentPort, workerData } from "node:worker_threads";
import { MessageContextArchiveReadCache } from "../messageContextArchiveReadCache.js";
import type { ManagerReadWorkerTask, ManagerReadWorkerMessage, ManagerReadWorkerRequest } from "./managerReadWorkerTasks.js";
export type { ManagerReadWorkerTask, ManagerReadWorkerMessage, ManagerReadWorkerRequest } from "./managerReadWorkerTasks.js";

const archiveReadCache = new MessageContextArchiveReadCache();

/** Search tasks must not initialize unrelated diagnostics, delivery or media modules. */
async function execute(task: ManagerReadWorkerTask): Promise<unknown> {
  if (task.type === "conversation_window") {
    const { readConversationWindow } = await import("../conversationMessageQuery.js");
    return readConversationWindow(task.dataDir, task.filter, task.query);
  }
  if (task.type === "role_message_endpoint_history") {
    const { recentMessageContextItems } = await import("../messageContextStore.js");
    return recentMessageContextItems([task.roleDir], task.query, {}, archiveReadCache);
  }
  if (task.type === "knowledge_search_delta") {
    const { readKnowledgeStorageDelta } = await import("./knowledgeSearchStorage.js");
    return readKnowledgeStorageDelta(task.roleDir, task.previous);
  }
  const tasks = await import("./managerReadWorkerTasks.js");
  return tasks.execute(task);
}
function send(message: ManagerReadWorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  if (process.send) {
    process.send(message);
    return;
  }
  throw new Error("Manager read process requires an IPC channel.");
}

async function respond(requestId: string, task: ManagerReadWorkerTask): Promise<void> {
  try {
    const value = await execute(task);
    send({ requestId, ok: true, value } satisfies ManagerReadWorkerMessage);
  } catch (error) {
    send({
      requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    } satisfies ManagerReadWorkerMessage);
  }
}

if (workerData) {
  void respond("one-shot", workerData as ManagerReadWorkerTask);
} else if (parentPort) {
  parentPort.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
  send({ type: "ready" });
} else if (process.send) {
  process.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
  process.once("disconnect", () => process.exit(0));
  send({ type: "ready" });
} else {
  throw new Error("Manager read process requires a parent channel.");
}

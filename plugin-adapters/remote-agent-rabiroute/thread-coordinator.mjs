import path from "node:path";
import { activeTurnIdFromThread } from "./task-lifecycle.mjs";

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function updatedTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function staleThreadError(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("thread not found") || message.includes("no rollout found for thread id");
}

function reusableTerminal(result) {
  return (result?.status === "completed" || result?.status === "failed")
    && result?.turnStatus !== "appServerExit"
    && result?.turnStatus !== "systemError"
    && result?.turnStatus !== "error";
}

export class CodexThreadCoordinator {
  constructor({ request, resolveModel, lifecycle, resumedTurnWaitMs, developerInstructions, onBusyThread }) {
    this.request = request;
    this.resolveModel = resolveModel;
    this.lifecycle = lifecycle;
    this.resumedTurnWaitMs = resumedTurnWaitMs;
    this.developerInstructions = developerInstructions;
    this.onBusyThread = onBusyThread;
  }

  async ensureThread(threadName, cwd) {
    const model = await this.resolveModel();
    for (const existing of await this.findThreads(threadName, cwd)) {
      const resumed = await this.resumeThread(existing.id, cwd, model);
      if (!resumed.resumed) continue;
      if (!resumed.activeTurnId) return existing.id;
      const terminal = await this.lifecycle.waitForTurnTerminal({
        turnId: resumed.activeTurnId,
        threadId: existing.id,
        timeoutMs: this.resumedTurnWaitMs
      });
      if (reusableTerminal(terminal)) return existing.id;
      this.onBusyThread?.({ threadId: existing.id, turnId: resumed.activeTurnId, terminal });
      break;
    }
    const result = await this.request("thread/start", {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      serviceName: "rabiroute-remote-agent",
      developerInstructions: this.developerInstructions
    });
    const threadId = String(result?.thread?.id || "").trim();
    if (!threadId) throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
    await this.request("thread/name/set", { threadId, name: threadName });
    return threadId;
  }

  async findThreads(threadName, cwd) {
    const found = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
        cwd,
        searchTerm: threadName
      });
      for (const thread of result?.data || []) {
        if (thread?.id && thread.name === threadName && samePath(thread.cwd, cwd)) found.push(thread);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return found.sort((left, right) => updatedTime(right.updatedAt) - updatedTime(left.updatedAt));
  }

  async resumeThread(threadId, cwd, model) {
    try {
      const result = await this.request("thread/resume", {
        threadId,
        model,
        cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        developerInstructions: this.developerInstructions
      });
      return { resumed: true, activeTurnId: activeTurnIdFromThread(result?.thread) };
    } catch (error) {
      if (staleThreadError(error)) return { resumed: false, activeTurnId: "" };
      throw error;
    }
  }
}

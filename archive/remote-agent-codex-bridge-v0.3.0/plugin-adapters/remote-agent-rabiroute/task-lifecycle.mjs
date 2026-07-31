const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const RETAINED_TERMINAL_TASKS = 2000;
const RETAINED_PENDING_TURNS = 200;
const MAX_REPLY_TEXT_CHARS = 12_000;

function errorMessage(value, fallback) {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const candidate = value.message || value.error?.message || value.error;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    try {
      return JSON.stringify(value);
    } catch {
      // fall through
    }
  }
  return fallback;
}

function retainBounded(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

export class RemoteTaskLifecycle {
  constructor({ emit }) {
    if (typeof emit !== "function") throw new Error("RemoteTaskLifecycle requires an emit callback.");
    this.emit = emit;
    this.turns = new Map();
    this.turnIdsByThread = new Map();
    this.pendingTurnTerminals = new Map();
    this.terminalTasks = new Map();
    this.taskWaiters = new Map();
    this.turnWaiters = new Map();
  }

  isTerminal(taskId) {
    return this.terminalTasks.has(String(taskId || ""));
  }

  send(event) {
    const taskId = String(event?.taskId || "").trim();
    if (!taskId) throw new Error("Remote Agent task event is missing taskId.");
    if (this.isTerminal(taskId)) return false;
    this.emit({ ...event, taskId });
    if (TERMINAL_STATUSES.has(event.status)) {
      retainBounded(this.terminalTasks, taskId, event.status, RETAINED_TERMINAL_TASKS);
      this.removeTaskTurns(taskId);
      this.settleTaskWaiters(taskId, { status: event.status });
    }
    return true;
  }

  waitForTaskTerminal(taskId, timeoutMs) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId) return Promise.reject(new Error("Remote task terminal wait requires taskId."));
    const existing = this.terminalTasks.get(normalizedTaskId);
    if (existing) return Promise.resolve({ status: existing });
    return this.createTimedWaiter(this.taskWaiters, normalizedTaskId, timeoutMs, {
      status: "timeout",
      error: `Remote task did not reach a terminal state within ${timeoutMs}ms.`
    });
  }

  waitForTurnTerminal({ turnId, threadId, timeoutMs }) {
    const normalizedTurnId = String(turnId || "").trim();
    if (!normalizedTurnId) return Promise.reject(new Error("Codex turn terminal wait requires turnId."));
    const pending = this.pendingTurnTerminals.get(normalizedTurnId);
    if (pending) return Promise.resolve(pending);
    return this.createTimedWaiter(this.turnWaiters, normalizedTurnId, timeoutMs, {
      status: "timeout",
      turnStatus: "timeout",
      threadId: String(threadId || "").trim(),
      error: `Codex turn ${normalizedTurnId} did not finish within ${timeoutMs}ms.`
    }, { threadId: String(threadId || "").trim() });
  }

  registerTurn({ taskId, turnId, threadId }) {
    const normalizedTaskId = String(taskId || "").trim();
    const normalizedTurnId = String(turnId || "").trim();
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedTaskId || !normalizedTurnId || !normalizedThreadId) {
      throw new Error("Remote Agent turn registration requires taskId, turnId, and threadId.");
    }
    if (this.isTerminal(normalizedTaskId)) return false;
    const turn = { taskId: normalizedTaskId, turnId: normalizedTurnId, threadId: normalizedThreadId };
    this.turns.set(normalizedTurnId, turn);
    const threadTurns = this.turnIdsByThread.get(normalizedThreadId) || new Set();
    threadTurns.add(normalizedTurnId);
    this.turnIdsByThread.set(normalizedThreadId, threadTurns);

    const pending = this.pendingTurnTerminals.get(normalizedTurnId);
    if (pending) {
      this.pendingTurnTerminals.delete(normalizedTurnId);
      this.finishTurn(turn, pending);
    }
    return !this.isTerminal(normalizedTaskId);
  }

  handleNotification(message) {
    if (message?.method === "turn/completed") {
      const params = message.params || {};
      const turnId = String(params.turn?.id || "").trim();
      const turnStatus = String(params.turn?.status || "missing");
      const terminal = {
        status: turnStatus === "completed" ? "completed" : "failed",
        turnStatus,
        error: params.turn?.error,
        replyText: turnStatus === "completed" ? replyTextFromCompletedTurn(params.turn) : "",
        threadId: String(params.threadId || "").trim()
      };
      if (turnId) this.settleTurnWaiters(turnId, terminal);
      const turn = turnId ? this.turns.get(turnId) : undefined;
      if (turn) {
        this.finishTurn(turn, terminal);
        return 1;
      }
      if (turnId) {
        retainBounded(this.pendingTurnTerminals, turnId, terminal, RETAINED_PENDING_TURNS);
        return 0;
      }
      return this.finishThreadTurns(terminal.threadId, terminal);
    }

    if (message?.method === "error" && message.params?.willRetry !== true) {
      const threadId = String(message.params?.threadId || "").trim();
      const terminal = {
        status: "failed",
        turnStatus: "error",
        error: message.params?.error,
        threadId
      };
      if (threadId) this.settleThreadTurnWaiters(threadId, terminal);
      else this.settleAllTurnWaiters(terminal);
      return threadId ? this.finishThreadTurns(threadId, terminal) : this.failAllActive(terminal);
    }

    if (message?.method === "thread/status/changed" && message.params?.status?.type === "systemError") {
      const threadId = String(message.params?.threadId || "").trim();
      const terminal = {
        status: "failed",
        turnStatus: "systemError",
        error: `Codex thread entered systemError: ${threadId}`,
        threadId
      };
      this.settleThreadTurnWaiters(threadId, terminal);
      return this.finishThreadTurns(threadId, terminal);
    }
    return 0;
  }

  handleAppServerExit(error) {
    const terminal = {
      status: "failed",
      turnStatus: "appServerExit",
      error,
      summary: "Codex app-server exited before the remote task completed."
    };
    this.settleAllTurnWaiters(terminal);
    const failed = this.failAllActive(terminal);
    this.pendingTurnTerminals.clear();
    return failed;
  }

  failAllActive(terminal) {
    const tasks = new Map();
    for (const turn of this.turns.values()) tasks.set(turn.taskId, turn);
    for (const turn of tasks.values()) {
      this.send({
        taskId: turn.taskId,
        status: "failed",
        error: errorMessage(terminal.error, terminal.summary || `Codex turn ended with status ${terminal.turnStatus || "failed"}.`),
        summary: terminal.summary || `Codex turn ended with status ${terminal.turnStatus || "failed"}.`
      });
    }
    this.turns.clear();
    this.turnIdsByThread.clear();
    return tasks.size;
  }

  finishThreadTurns(threadId, terminal) {
    if (!threadId) return 0;
    const turnIds = [...(this.turnIdsByThread.get(threadId) || [])];
    let finished = 0;
    for (const turnId of turnIds) {
      const turn = this.turns.get(turnId);
      if (!turn) continue;
      this.finishTurn(turn, terminal);
      finished += 1;
    }
    return finished;
  }

  finishTurn(turn, terminal) {
    const failed = terminal.status === "failed";
    const replyText = failed ? "" : String(terminal.replyText || "").trim();
    this.send({
      taskId: turn.taskId,
      status: failed ? "failed" : "completed",
      summary: failed
        ? `Codex turn ended with status ${terminal.turnStatus || "failed"}.`
        : replyText || "Codex turn completed through app-server without a final agent message.",
      error: failed
        ? errorMessage(terminal.error, `Codex turn ended with status ${terminal.turnStatus || "failed"}.`)
        : undefined,
      data: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        turnStatus: terminal.turnStatus,
        ...(replyText ? { replyText } : {})
      }
    });
    this.removeTurn(turn.turnId);
  }

  removeTaskTurns(taskId) {
    for (const turn of [...this.turns.values()]) {
      if (turn.taskId === taskId) this.removeTurn(turn.turnId);
    }
  }

  removeTurn(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    const threadTurns = this.turnIdsByThread.get(turn.threadId);
    threadTurns?.delete(turnId);
    if (!threadTurns?.size) this.turnIdsByThread.delete(turn.threadId);
  }

  createTimedWaiter(waiterMap, key, timeoutMs, timeoutResult, metadata = {}) {
    const boundedTimeout = Number(timeoutMs);
    if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0) {
      return Promise.reject(new Error("Remote Agent wait timeout must be a positive finite number."));
    }
    return new Promise((resolve) => {
      const waiters = waiterMap.get(key) || new Set();
      const waiter = { resolve, timer: null, ...metadata };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        if (!waiters.size) waiterMap.delete(key);
        resolve(timeoutResult);
      }, boundedTimeout);
      waiters.add(waiter);
      waiterMap.set(key, waiters);
    });
  }

  settleTaskWaiters(taskId, result) {
    this.settleWaiterSet(this.taskWaiters, taskId, result);
  }

  settleTurnWaiters(turnId, result) {
    this.settleWaiterSet(this.turnWaiters, turnId, result);
  }

  settleThreadTurnWaiters(threadId, result) {
    if (!threadId) return;
    for (const [turnId, waiters] of this.turnWaiters.entries()) {
      if ([...waiters].some((waiter) => waiter.threadId === threadId)) {
        this.settleTurnWaiters(turnId, result);
      }
    }
  }

  settleAllTurnWaiters(result) {
    for (const turnId of [...this.turnWaiters.keys()]) this.settleTurnWaiters(turnId, result);
  }

  settleWaiterSet(waiterMap, key, result) {
    const waiters = waiterMap.get(key);
    if (!waiters) return;
    waiterMap.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }
}

export function activeTurnIdFromThread(thread) {
  if (!Array.isArray(thread?.turns)) return "";
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress" && typeof turn.id === "string" && turn.id) return turn.id;
  }
  return "";
}

export function replyTextFromCompletedTurn(turn, maxChars = MAX_REPLY_TEXT_CHARS) {
  if (!Array.isArray(turn?.items)) return "";
  const messages = turn.items
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ text: item.text.trim(), phase: String(item.phase || "") }));
  if (!messages.length) return "";
  const finalMessages = messages.filter((item) => item.phase === "final_answer" || item.phase === "final" || item.phase === "finalAnswer");
  const selected = finalMessages.length ? finalMessages : [messages.at(-1)];
  const combined = selected.map((item) => item.text).join("\n\n");
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : MAX_REPLY_TEXT_CHARS;
  if (combined.length <= limit) return combined;
  const suffix = "\n…[truncated by RabiRoute]";
  return `${combined.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

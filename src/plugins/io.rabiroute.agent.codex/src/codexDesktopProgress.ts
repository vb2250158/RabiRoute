export type CodexDesktopProgressMessage = {
  threadId: string;
  turnId: string;
  messageId: string;
  completedAtMs: number;
  text: string;
};

export type CodexDesktopTurnOutcome = "completed" | "failed" | "interrupted";

type Patch = { op?: string; path?: unknown[]; value?: unknown };
type Turn = { turnId?: unknown; status?: unknown; items?: unknown[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const entityPath = ["turnHistory", "history", "entitiesByKey"];

/** Read the original Desktop owner's versioned live view. A snapshot only establishes a baseline. */
export class CodexDesktopProgress {
  private owner?: string;
  private revision?: number;
  private entityKey?: string;
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(readonly threadId: string, readonly turnId: string) {}

  read(message: { sourceClientId?: string; version?: number; params?: unknown }): {
    messages: CodexDesktopProgressMessage[]; closed?: true; resubscribe?: true; outcome?: CodexDesktopTurnOutcome
  } {
    const params = record(message.params);
    if (message.version !== 13 || !message.sourceClientId || params?.hostId !== "local" || params.conversationId !== this.threadId) {
      return { messages: [] };
    }
    const change = record(params.change);
    if (!change || typeof change.revision !== "number") return { messages: [] };
    if (change.type === "snapshot") {
      const state = record(change.conversationState);
      if (state?.id !== this.threadId) return { messages: [] };
      this.owner = message.sourceClientId;
      this.revision = change.revision;
      this.entityKey = undefined;
      this.started.clear();
      const history = record(record(state.turnHistory)?.history);
      for (const [key, value] of Object.entries(record(history?.entitiesByKey) ?? {})) {
        const turn = record(value) as Turn | undefined;
        if (turn?.turnId !== this.turnId) continue;
        if (this.terminal(turn.status)) return { messages: [], closed: true, outcome: turn.status };
        if (turn.status === "inProgress") {
          this.entityKey = key;
          for (const item of turn.items ?? []) this.acceptItem(item, []);
        }
        break;
      }
      return { messages: [] };
    }
    if (change.type !== "patches" || this.owner !== message.sourceClientId || this.revision === undefined
      || change.revision <= this.revision || !Array.isArray(change.patches)) return { messages: [] };
    if (change.baseRevision !== this.revision) {
      this.revision = undefined;
      this.started.clear();
      return { messages: [], resubscribe: true };
    }
    this.revision = change.revision;
    const messages: CodexDesktopProgressMessage[] = [];
    let closed = false;
    let outcome: CodexDesktopTurnOutcome | undefined;
    for (const patch of change.patches as Patch[]) {
      if (!patch || typeof patch !== "object") continue;
      const parts = patch.path;
      if (!Array.isArray(parts) || !entityPath.every((part, index) => parts[index] === part) || typeof parts[3] !== "string") continue;
      const key = parts[3];
      if (parts.length === 4 && patch.op !== "remove") {
        const turn = record(patch.value) as Turn | undefined;
        if (turn?.turnId !== this.turnId) continue;
        if (this.terminal(turn.status)) { closed = true; outcome = turn.status; continue; }
        if (turn.status !== "inProgress") continue;
        this.entityKey = key;
        // Structural replacements can include existing history, so use them only as a baseline.
        for (const item of turn.items ?? []) this.acceptItem(item, []);
      }
      if (!this.entityKey && parts.length === 5 && parts[4] === "turnId" && patch.value === this.turnId) this.entityKey = key;
      if (key !== this.entityKey) continue;
      if ((parts.length === 4 && patch.op === "remove") || (parts.length === 5 && parts[4] === "status" && this.terminal(patch.value))) {
        closed = true;
        if (this.terminal(patch.value)) outcome = patch.value;
      }
      if (!closed && parts.length === 6 && parts[4] === "items" && typeof parts[5] === "number"
        && (patch.op === "add" || patch.op === "replace")) {
        this.acceptItem(patch.value, messages);
      }
    }
    return { messages, ...(closed ? { closed: true as const } : {}), ...(outcome ? { outcome } : {}) };
  }

  private terminal(status: unknown): status is CodexDesktopTurnOutcome {
    return status === "completed" || status === "failed" || status === "interrupted";
  }

  private acceptItem(value: unknown, messages: CodexDesktopProgressMessage[]): void {
    const item = record(value);
    if (item?.type !== "agentMessage" || item.phase !== "commentary" || typeof item.id !== "string" || !item.id
      || this.completed.has(item.id)) return;
    if (item.completedAtMs == null) {
      this.started.add(item.id);
      return;
    }
    if (typeof item.completedAtMs !== "number" || !Number.isFinite(item.completedAtMs)) return;
    this.completed.add(item.id);
    if (!this.started.delete(item.id) || typeof item.text !== "string" || !item.text.trim()) return;
    messages.push({ threadId: this.threadId, turnId: this.turnId, messageId: item.id,
      completedAtMs: item.completedAtMs, text: item.text });
  }
}

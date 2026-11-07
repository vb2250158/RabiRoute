import { ApiContractError } from "./apiOperationContract.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { TERMINAL_LIMITS } from "../shared/agentInteractiveProtocol.js";
export type RemoteTerminalEvent = { sequence: number; type: string; data?: string; exitCode?: number | null };
type Session = { events: RemoteTerminalEvent[]; bytes: number; sequence: number; ended: boolean; listeners: Set<(event: RemoteTerminalEvent) => void> };

/** Local Registry evidence: invocation stopped before a dispatch was started. Never deserialize this from a peer. */
export class TerminalDispatchNotSentError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Ephemeral transport replay only. The remote process owns session state. */
export class LanAgentTerminals {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly invoke: (instanceId: string, body: Record<string, unknown>, assertAuthorized?: () => void) => Promise<unknown>) {}
  private key(instanceId: string, terminalId: unknown): string {
    if (typeof terminalId !== "string" || !new RegExp(TERMINAL_LIMITS.idPattern).test(terminalId)) throw new Error("Invalid terminal ID.");
    return `${instanceId}/${terminalId}`;
  }
  async execute(instanceId: string, body: Record<string, unknown>, assertAuthorized: () => void = () => {}): Promise<unknown> {
    assertAuthorized();
    let created: { key: string; session: Session } | undefined;
    if (body.action === "open") {
      const key = this.key(instanceId, body.terminalId);
      if (!this.sessions.has(key)) {
        if (this.sessions.size >= TERMINAL_LIMITS.transportSessions) {
          for (const [cachedKey, cached] of this.sessions) {
            if (cached.ended && !cached.listeners.size) this.sessions.delete(cachedKey);
            if (this.sessions.size < TERMINAL_LIMITS.transportSessions) break;
          }
        }
        const session: Session = { events: [], bytes: 0, sequence: 0, ended: false, listeners: new Set() };
        this.sessions.set(key, session); created = { key, session };
      }
    }
    let pending: Promise<unknown>;
    try { assertAuthorized(); pending = this.invoke(instanceId, body, assertAuthorized); }
    catch (error) {
      // Synchronous local evidence is handled before yielding, so another open cannot
      // dispatch through this placeholder between failed admission and its removal.
      if (error instanceof TerminalDispatchNotSentError && created
        && this.sessions.get(created.key) === created.session
        && created.session.sequence === 0 && !created.session.listeners.size) this.sessions.delete(created.key);
      throw error;
    }
    const result = await pending; assertAuthorized(); return result;
  }
  private parameterFailure(instanceId: string, terminalId: string, field: "after" | "waitMs", operationId: string): ApiContractError {
    const path = `/api/lan-agent/instances/${encodeURIComponent(instanceId)}/terminals/${encodeURIComponent(terminalId)}`;
    const reason = field === "after"
      ? "after must be a safe integer from 0 through the current output sequence"
      : `waitMs must be an integer from 0 through ${getTimeoutMs("agent.terminalWait", TERMINAL_LIMITS.waitMs)}`;
    return new ApiContractError(400, field === "after" ? "TERMINAL_OUTPUT_CURSOR_INVALID" : "TERMINAL_WAIT_INVALID", `query.${field}`, operationId,
      false, undefined, `${reason}. Read GET ${path}?after=0&waitMs=0 for data.nextOutputSequence; retain the same instanceId and terminalId. `
      + "This read may report truncated output; it does not replay input or open a terminal. Lookup failures and 401/403 are connection/access failures, not evidence that a process is missing");
  }
  async read(instanceId: string, terminalId: string, after = 0, waitMs = 0, assertAuthorized: () => void = () => {}): Promise<unknown> {
    assertAuthorized();
    const key = this.key(instanceId, terminalId);
    const session = this.sessions.get(key);
    if (!session) throw Object.assign(new Error("Terminal stream not found. Open the session on this connection first."), { code: "TERMINAL_STREAM_NOT_FOUND" });
    if (!Number.isSafeInteger(after) || after < 0 || after > session.sequence) throw this.parameterFailure(instanceId, terminalId, "after", "manager.lan-agent.terminals.read");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > getTimeoutMs("agent.terminalWait", TERMINAL_LIMITS.waitMs)) throw this.parameterFailure(instanceId, terminalId, "waitMs", "manager.lan-agent.terminals.read");
    if (waitMs && after === session.sequence && !session.ended) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(deadline); session.listeners.delete(listener); resolve(); };
        const listener = () => finish();
        const deadline = setTimeout(finish, waitMs);
        session.listeners.add(listener);
      });
    }
    if (this.sessions.get(key) !== session) throw new Error("Terminal connection changed; query the current node before continuing.");
    assertAuthorized(); const terminal = await this.invoke(instanceId, { action: "get", terminalId }, assertAuthorized); assertAuthorized();
    if (this.sessions.get(key) !== session) throw new Error("Terminal connection changed while reading output.");
    const oldest = session.events[0]?.sequence ?? 1;
    return { terminal, outputEvents: session.events.filter(event => event.sequence > after),
      nextOutputSequence: session.sequence, truncated: after < oldest - 1 };
  }
  receive(instanceId: string, body: Record<string, unknown>): void {
    let key: string;
    try { key = this.key(instanceId, body.terminalId); } catch { return; }
    const session = this.sessions.get(key);
    if (!session || session.ended || !["output", "exit"].includes(String(body.type))) return;
    const event: RemoteTerminalEvent = { sequence: ++session.sequence, type: String(body.type),
      ...(body.type === "output" && typeof body.data === "string" ? { data: body.data.slice(0, TERMINAL_LIMITS.eventCodeUnits) } : {}),
      ...(body.type === "exit" ? { exitCode: typeof body.exitCode === "number" ? body.exitCode : null } : {}) };
    const size = Buffer.byteLength(event.data || "") + 64;
    session.events.push(event); session.bytes += size;
    while (session.bytes > TERMINAL_LIMITS.replayBytes || session.events.length > TERMINAL_LIMITS.replayEvents) {
      const removed = session.events.shift()!; session.bytes -= Buffer.byteLength(removed.data || "") + 64;
    }
    if (event.type === "exit") session.ended = true;
    for (const listener of [...session.listeners]) listener(event);
  }
  subscribe(instanceId: string, terminalId: string, after: number, listener: (event: RemoteTerminalEvent) => void): () => void {
    const session = this.sessions.get(this.key(instanceId, terminalId));
    if (!session) throw Object.assign(new Error("Terminal stream not found. Query or open the session first."), { code: "TERMINAL_STREAM_NOT_FOUND" });
    if (!Number.isSafeInteger(after) || after < 0 || after > session.sequence) throw this.parameterFailure(instanceId, terminalId, "after", "manager.lan-agent.terminals.events");
    const oldest = session.events[0]?.sequence ?? 1;
    if (after < oldest - 1) listener({ type: "gap", sequence: oldest - 1, data: "Earlier terminal output was discarded from the bounded buffer." });
    for (const event of session.events) if (event.sequence > after) listener(event);
    if (session.ended) return () => undefined;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }
  disconnect(instanceId: string): void {
    for (const [key, session] of this.sessions) if (key.startsWith(`${instanceId}/`)) {
      if (!session.ended) for (const listener of [...session.listeners]) listener({ sequence: ++session.sequence, type: "disconnected" });
      session.listeners.clear(); this.sessions.delete(key);
    }
  }
}

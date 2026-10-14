export type RemoteTerminalEvent = { sequence: number; type: string; data?: string; exitCode?: number | null };
type Session = { events: RemoteTerminalEvent[]; bytes: number; sequence: number; ended: boolean; listeners: Set<(event: RemoteTerminalEvent) => void> };

/** Ephemeral transport replay only. The remote process owns session state. */
export class LanAgentTerminals {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly invoke: (instanceId: string, body: Record<string, unknown>) => Promise<unknown>) {}
  private key(instanceId: string, terminalId: unknown): string {
    if (typeof terminalId !== "string" || !/^[a-f0-9-]{36}$/.test(terminalId)) throw new Error("Invalid terminal ID.");
    return `${instanceId}/${terminalId}`;
  }
  async execute(instanceId: string, body: Record<string, unknown>): Promise<unknown> {
    if (body.action === "open") {
      const key = this.key(instanceId, body.terminalId);
      if (!this.sessions.has(key)) {
        if (this.sessions.size >= 128) throw new Error("Terminal transport history is full; close sessions before restarting the node connection.");
        this.sessions.set(key, { events: [], bytes: 0, sequence: 0, ended: false, listeners: new Set() });
      }
    }
    return this.invoke(instanceId, body);
  }
  async read(instanceId: string, terminalId: string, after = 0, waitMs = 0): Promise<unknown> {
    const key = this.key(instanceId, terminalId);
    const session = this.sessions.get(key);
    if (!session) throw new Error("Terminal stream not found. Open the session on this connection first.");
    if (!Number.isSafeInteger(after) || after < 0 || after > session.sequence) throw new Error("Invalid terminal output cursor.");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) throw new Error("waitMs must be between 0 and 25000.");
    if (waitMs && after === session.sequence && !session.ended) {
      await new Promise<void>((resolve, reject) => {
        if (session.listeners.size >= 4) { reject(new Error("Terminal already has four attached viewers.")); return; }
        const finish = () => { clearTimeout(deadline); session.listeners.delete(listener); resolve(); };
        const listener = () => finish();
        const deadline = setTimeout(finish, waitMs);
        session.listeners.add(listener);
      });
    }
    if (this.sessions.get(key) !== session) throw new Error("Terminal connection changed; query the current node before continuing.");
    const terminal = await this.invoke(instanceId, { action: "get", terminalId });
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
      ...(body.type === "output" && typeof body.data === "string" ? { data: body.data.slice(0, 16384) } : {}),
      ...(body.type === "exit" ? { exitCode: typeof body.exitCode === "number" ? body.exitCode : null } : {}) };
    const size = Buffer.byteLength(event.data || "") + 64;
    session.events.push(event); session.bytes += size;
    while (session.bytes > 262144 || session.events.length > 2048) {
      const removed = session.events.shift()!; session.bytes -= Buffer.byteLength(removed.data || "") + 64;
    }
    if (event.type === "exit") session.ended = true;
    for (const listener of [...session.listeners]) listener(event);
  }
  subscribe(instanceId: string, terminalId: string, after: number, listener: (event: RemoteTerminalEvent) => void): () => void {
    const session = this.sessions.get(this.key(instanceId, terminalId));
    if (!session) throw new Error("Terminal stream not found. Query or open the session first.");
    if (!Number.isSafeInteger(after) || after < 0 || after > session.sequence) throw new Error("Invalid terminal output cursor.");
    if (session.listeners.size >= 4) throw new Error("Terminal already has four attached viewers.");
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

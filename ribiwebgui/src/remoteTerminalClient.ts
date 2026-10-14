export type RemoteTerminal = { terminalId: string; shell: "cmd" | "powershell"; cwd: string; state: string; pid?: number; createdAt: string; nextInputSequence: number; exitCode?: number };
export type TerminalEvent = { sequence: number; type: string; data?: string; exitCode?: number };

export class RemoteTerminalClient {
  private readonly base: string;
  constructor(instanceId: string, private readonly token: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.base = `/api/lan-agent/instances/${encodeURIComponent(instanceId)}/terminals`;
  }
  private headers() { return { "x-rabiroute-webgui-token": this.token, "content-type": "application/json" }; }
  async request<T>(body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.base, { method: body ? "POST" : "GET", headers: this.headers(), cache: "no-store", ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || `请求失败：HTTP ${response.status}`);
    return result.data as T;
  }
  async events(terminalId: string, signal: AbortSignal, receive: (event: TerminalEvent) => void): Promise<void> {
    const response = await this.fetcher(`${this.base}/${encodeURIComponent(terminalId)}/events`, { headers: this.headers(), cache: "no-store", signal });
    if (!response.ok || !response.body) throw new Error("终端输出连接失败，请查询会话后重新打开。");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 1048576) throw new Error("终端输出帧过大，已停止读取。");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) receive(JSON.parse(line.slice(6)) as TerminalEvent);
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

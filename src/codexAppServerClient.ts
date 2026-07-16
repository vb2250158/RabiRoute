import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type AppServerRequestId = number | string;

type AppServerMessage = {
  id?: AppServerRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export type CodexAppServerClientOptions = {
  command: string;
  commandArgs?: string[];
  cwd: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  overloadRetryLimit?: number;
  overloadRetryBaseMs?: number;
  clientVersion?: string;
  onNotification?: (message: AppServerMessage) => void;
  onServerRequest?: (message: Required<Pick<AppServerMessage, "id" | "method">> & Pick<AppServerMessage, "params">) => Promise<unknown>;
  onExit?: (error: Error) => void;
};

const defaultRequestTimeoutMs = 60_000;
const mutationRequestTimeoutMs = 180_000;
const defaultOverloadRetryLimit = 3;
const defaultOverloadRetryBaseMs = 250;

class CodexAppServerRpcError extends Error {
  constructor(readonly code: number | undefined, readonly detail: unknown) {
    super(JSON.stringify(detail));
    this.name = "CodexAppServerRpcError";
  }
}
function timeoutForMethod(method: string, configured: number | undefined): number {
  if (configured) return configured;
  return method === "thread/start" || method === "turn/start" || method === "turn/steer"
    ? mutationRequestTimeoutMs
    : defaultRequestTimeoutMs;
}

export function codexAppServerRequestEnvelopeForTest(
  id: AppServerRequestId,
  method: string,
  params: unknown
): AppServerMessage {
  return { id, method, params };
}

export function codexAppServerNotificationEnvelopeForTest(method: string): AppServerMessage {
  return { method };
}

export function failClosedCodexServerRequestForTest(method: string): unknown {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  throw new Error(`RabiRoute has no approved handler for Codex server request: ${method}`);
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private stderrLog: fs.WriteStream | null = null;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    return this.requestConnectedWithOverloadRetry(method, params);
  }

  async start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    if (this.child && !this.child.killed && this.child.exitCode == null) {
      return;
    }

    this.starting = this.startInternal();
    try {
      await this.starting;
    } catch (error) {
      this.stopCurrentChild();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  close(): void {
    this.stopCurrentChild();
    this.rejectPending(new Error("Codex app-server client closed."));
  }

  private async startInternal(): Promise<void> {
    fs.mkdirSync(this.options.dataDir, { recursive: true });
    const stderrPath = path.join(this.options.dataDir, "codex-app-server.stderr.log");
    this.stderrLog = fs.createWriteStream(stderrPath, { flags: "a" });

    const child = spawn(this.options.command, [...(this.options.commandArgs ?? []), "app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.pipe(this.stderrLog, { end: false });
    child.stdin.once("error", (error) => this.handleExit(child, error));

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.child === child) this.handleLine(child, line);
    });
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      this.handleExit(child, new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)}).`));
    });

    await this.requestConnectedWithOverloadRetry("initialize", {
      clientInfo: {
        name: "rabiroute",
        title: "RabiRoute",
        version: this.options.clientVersion ?? "unknown"
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false
      }
    });
    this.writeMessage(codexAppServerNotificationEnvelopeForTest("initialized"));
  }

  private requestConnected(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || child.exitCode != null) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }

    const id = this.nextId++;
    const timeoutMs = timeoutForMethod(method, this.options.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage(codexAppServerRequestEnvelopeForTest(id, method, params));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async requestConnectedWithOverloadRetry(method: string, params: unknown): Promise<unknown> {
    const retryLimit = this.options.overloadRetryLimit ?? defaultOverloadRetryLimit;
    const baseMs = this.options.overloadRetryBaseMs ?? defaultOverloadRetryBaseMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestConnected(method, params);
      } catch (error) {
        if (!(error instanceof CodexAppServerRpcError) || error.code !== -32001 || attempt >= retryLimit) {
          throw error;
        }
        const exponentialMs = baseMs * (2 ** attempt);
        const jitteredMs = Math.max(0, Math.round(exponentialMs * (0.5 + Math.random())));
        await new Promise((resolve) => setTimeout(resolve, jitteredMs));
      }
    }
  }

  private writeMessage(message: AppServerMessage): void {
    const child = this.child;
    if (!child) {
      throw new Error("Codex app-server is not running.");
    }
    this.writeMessageToChild(child, message);
  }

  private writeMessageToChild(child: ChildProcessWithoutNullStreams, message: AppServerMessage): void {
    if (this.child !== child) {
      throw new Error("Codex app-server request belongs to a stale process.");
    }
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: AppServerMessage;
    try {
      message = JSON.parse(trimmed) as AppServerMessage;
    } catch {
      this.stderrLog?.write(`[rabiroute] non-JSON stdout: ${trimmed}\n`);
      return;
    }

    if (message.id != null && message.method) {
      void this.handleServerRequest(
        child,
        message as Required<Pick<AppServerMessage, "id" | "method">> & Pick<AppServerMessage, "params">
      ).catch((error) => this.logClientError("server request handling failed", error));
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error != null) {
        const code = message.error && typeof message.error === "object" && typeof (message.error as { code?: unknown }).code === "number"
          ? (message.error as { code: number }).code
          : undefined;
        pending.reject(new CodexAppServerRpcError(code, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.options.onNotification?.(message);
  }

  private async handleServerRequest(
    child: ChildProcessWithoutNullStreams,
    message: Required<Pick<AppServerMessage, "id" | "method">> & Pick<AppServerMessage, "params">
  ): Promise<void> {
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(message)
        : failClosedCodexServerRequestForTest(message.method);
      this.writeMessageToChild(child, { id: message.id, result });
    } catch (error) {
      try {
        this.writeMessageToChild(child, {
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      } catch (responseError) {
        this.logClientError("failed to reject Codex server request", responseError);
      }
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.detachChild(child);
    if (!child.killed && child.exitCode == null) child.kill();
    this.rejectPending(error);
    this.options.onExit?.(error);
  }

  private stopCurrentChild(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      this.detachChild(child);
      if (!child.killed) child.kill();
    } else {
      this.stderrLog?.end();
      this.stderrLog = null;
    }
  }

  private detachChild(child: ChildProcessWithoutNullStreams): void {
    child.stderr.unpipe(this.stderrLog ?? undefined);
    this.stderrLog?.end();
    this.stderrLog = null;
  }

  private logClientError(context: string, error: unknown): void {
    this.stderrLog?.write(`[rabiroute] ${context}: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

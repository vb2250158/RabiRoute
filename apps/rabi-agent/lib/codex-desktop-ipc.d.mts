export class CodexDesktopIpcClient {
  constructor(options?: {
    timeout?: (key: string, fallback: number) => number;
    onBroadcast?: (event: unknown) => void;
  });
  startTurn(input: { threadId: string; prompt: string; cwd: string; model?: string; reasoningEffort?: string }): Promise<unknown>;
  close(): void;
}
export function codexDesktopIpcPaths(options?: Record<string, unknown>): string[];

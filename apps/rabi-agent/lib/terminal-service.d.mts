export class TerminalService {
  constructor(options: { emit(event: Record<string, unknown>): void; timeout?: (key: string, fallback: number) => number;
    defaultCwd?: string; onChange?: () => void; historyDirectory?: string });
  readonly shells: string[];
  readonly activeCount: number;
  execute(input: Record<string, unknown>): Promise<unknown>;
  closeAll(): Promise<unknown[]>;
  stop(): Promise<void>;
}

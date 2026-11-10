import type { ComputerExecutionContext, ComputerSettings } from "./computer-control-contract.mjs";
export type ComputerPresentationTheme = { theme: string; customThemes?: readonly unknown[]; customTheme?: unknown };
export class ComputerService {
  constructor(options?: { onChange?: () => void; onControlChange?: () => void; uploadHistoryRoot?: string; historyIo?: unknown;
    qtPresentation?: { command: string; args: string[] }; getPresentationTheme?: () => ComputerPresentationTheme | undefined;
    instanceId?: string | (() => string); getSettings?: () => ComputerSettings; receiptRoot?: string;
    nativeFactory?: (options: { children: Set<unknown>; timeout: (key: string, fallback: number) => number }) => unknown;
    timeout?: (key: string, fallback: number) => number; maxUploadBytes?: number; maxConcurrentIo?: number;
    maxActiveUploads?: number; maxUploadRecords?: number });
  readonly activeCount: number;
  readonly capabilities: string[];
  setPresentationTheme(snapshot?: ComputerPresentationTheme): Promise<void>;
  connectionClosed(): Promise<void>;
  endSource(connectionId: string): Promise<unknown>;
  endTask(taskId: string, sourceId: string): Promise<unknown>;
  execute(input: Record<string, unknown>, context?: ComputerExecutionContext): Promise<unknown>;
  reconcileSettings(context?: Partial<ComputerExecutionContext>): Promise<void>;
  stop(): Promise<void>;
}

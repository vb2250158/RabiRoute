export class ComputerService {
  constructor(options?: { onChange?: () => void; uploadHistoryRoot?: string; historyIo?: unknown;
    timeout?: (key: string, fallback: number) => number; maxUploadBytes?: number; maxConcurrentIo?: number;
    maxActiveUploads?: number; maxUploadRecords?: number });
  readonly activeCount: number;
  execute(input: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

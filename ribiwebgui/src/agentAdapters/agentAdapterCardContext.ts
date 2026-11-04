import type { AgentAdapterType, AgentScanResult, RuntimeStatus } from "../types";

export type AgentCardScanOptions = Readonly<{ append?: boolean; offset?: number; limit?: number }>;
export type AgentCardScanState = Readonly<{
  threadNames: string[];
  cwdOptions: string[];
  copilotSessions: Array<{ name: string; cwd?: string; userNamed?: boolean }>;
  copilotBins: string[];
  marvisAppIds: string[];
  agents: Partial<Record<AgentAdapterType, AgentScanResult>>;
  loading: boolean;
}>;

/** Route identity and its existing draft owner remain authoritative across lazy card loading. */
export type AgentAdapterCardContext = Readonly<{
  routeId: string;
  targetId: string;
  agentType: AgentAdapterType;
  runtime: RuntimeStatus;
  scanState: AgentCardScanState;
  scanError?: string;
  touch(): void;
  refreshScan(options?: AgentCardScanOptions): Promise<void>;
  loadMoreSessions(): Promise<void>;
}>;

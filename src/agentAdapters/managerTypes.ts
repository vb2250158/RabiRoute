import type {AgentAdapterType} from './types.js';
import type {AgentAdapterMaturity} from '../shared/agentAdapterCapabilities.js';
import type {CodexModelCatalogEntry} from './codexContracts.js';
import type {DshModelCatalogEntry,listDshAgentPresets} from '../plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js';
import type { DshLocalDiscovery } from "../plugins/io.rabiroute.agent.dsh/src/dshDiscovery.js";
import type { AgentAdapterDescriptor } from "@rabiroute/plugin-sdk";
import type { AgentManagerProvider } from "../manager/agentManagerProviders.js";
export type AgentMaturity = AgentAdapterMaturity;

export type AgentScanModel = {
  id: string;
  name: string;
  provider?: string;
  providerName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: Array<{ id: string; description?: string }>;
};

export type AgentScanSession = {
  id?: string;
  /** Native owner identity supplied by the adapter, separate from its opaque session ID. */
  ownerId?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
  /** Task status as reported by the host, when the adapter can read one. */
  status?: string;
  /**
   * True when a live session process is currently serving this task, so it can
   * accept a delivery. False or absent means the UI must not present it as
   * immediately deliverable.
   */
  live?: boolean;
};

export type AgentSessionPageQuery = {
  limit: number;
  offset: number;
  query?: string;
};

export type AgentSessionPage = {
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
};

export type AgentScanOptions = {
  grokBotAgentId?: string;
  grokBotProfilePath?: string;
  grokBotBackendUrl?: string;
  grokBotLimit?: number;
  grokBotOffset?: number;
  grokBotQuery?: string;
  codexLimit?: number;
  codexOffset?: number;
  codexQuery?: string;
  codexCatalogTimeoutMs?: number;
  dshLimit?: number;
  dshOffset?: number;
  dshQuery?: string;
  dshBaseUrl?: string;
  workbuddyLimit?: number;
  workbuddyOffset?: number;
  workbuddyQuery?: string;
  workbuddyWorkspace?: string;
  antigravityLimit?: number;
  antigravityOffset?: number;
  antigravityQuery?: string;
  antigravityWorkspace?: string;
};

export type AgentScanPerformanceOperation = {
  operation: string;
  durationMs: number;
  error: boolean;
};

export type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

export type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  sessionPage?: AgentSessionPage;
  models?: AgentScanModel[];
  agentPresets?: Array<{ id: string; name?: string; description?: string; broken?: string }>;
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean; details?: string[] }>;
  warnings?: string[];
  transport?: { protocol: string; mode: string };
  host?: { name: string; required: boolean };
};

export type GatewayDefinitionLike = {
  remoteAgentTargets?: import("../shared/routeAgentTargets.js").RemoteAgentTarget[];
  grokBotProfilePath?: string;
  grokBotBackendUrl?: string;
  grokBotAgentId?: string;
  grokBotSessionId?: string;
  grokBotSessionName?: string;
  id?: string;
  name?: string;
  routeName?: string;
  configName?: string;
  agentAdapters?: AgentAdapterType[];
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
  workbuddySessionId?: string;
  workbuddySessionName?: string;
  workbuddyCwd?: string;
  workbuddyEndpoint?: string;
  copilotThreadName?: string;
  copilotCwd?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
};

export type AgentScanRuntimeSnapshot = {
  definition: GatewayDefinitionLike;
};

export type CopilotSessionEntry = {
  id: string;
  name: string;
  cwd?: string;
  userNamed?: boolean;
  updatedAt?: string;
};

export type AstrbotSessionScan = {
  warnings?: string[];
  authVerified: boolean;
  authMessage?: string;
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  source: "api" | "local-db" | "none";
};

export type AstrbotLoginTestRequest = {
  url?: string;
  username?: string;
  password?: string;
};

export type MarvisOpenRequest = {
  appId?: string;
  url?: string;
};

export type AgentManagerApiContext = {
  rootDir: string;
  manifest?: AgentAdapterDescriptor;
  providers?: readonly AgentManagerProvider[];
  scanSignal?: AbortSignal;
  runtimes?: Iterable<AgentScanRuntimeSnapshot>;
  getRuntimes?: () => Iterable<AgentScanRuntimeSnapshot>;
  projects?: AgentScanProject[];
  codexSessions?: AgentScanSession[];
  codexBins?: string[];
  threadNames?: string[];
  cwdOptions?: string[];
  copilotSessions?: CopilotSessionEntry[];
  copilotBins?: string[];
  marvisAppIds?: string[];
  checkHttpEndpoint?: (url: string, timeoutMs?: number) => Promise<boolean>;
  resolveWingetCopilot?: () => string | null;
  listCodexSessions?: (
    query: AgentSessionPageQuery,
    options?: { signal?: AbortSignal }
  ) => Promise<AgentScanSession[]>;
  isCodexDesktopReady?: () => Promise<boolean>;
  listCodexModels?: (cwd: string, timeoutMs?: number) => Promise<CodexModelCatalogEntry[]>;
  dshSessions?: AgentScanSession[];
  listDshSessions?: (query: AgentSessionPageQuery & { baseUrl: string }) => Promise<AgentScanSession[]>;
  listDshModels?: (baseUrl: string) => Promise<{ models: DshModelCatalogEntry[]; warnings: string[] }>;
  listDshAgentPresets?: typeof listDshAgentPresets;
  discoverLocalDsh?: () => DshLocalDiscovery;
  /** Overrides for the WorkBuddy session descriptor directory and task database. */
  workbuddySessionsDir?: string;
  workbuddyDatabasePath?: string;
  /** Overrides for the Antigravity conversation index and host process probe. */
  antigravityDatabasePath?: string;
  antigravityAppDataDir?: string;
  antigravityCliPath?: string;
  isAntigravityHostRunning?: () => boolean;
};

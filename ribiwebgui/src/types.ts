import type {
  AgentAdapterType,
  GatewayDefinition,
  MessageAdapterPolicies,
  MessageAdapterPolicy,
  MessageAdapterType,
  MessagePayloadKind,
  NapCatInstanceDefinition,
  NotificationScheduleDefinition,
  NotificationRuleDefinition,
  PipelineDefinition
} from "@shared/gatewayConfigModel";
import type { PersonaAvatarPresentation } from "@shared/personaAvatarContract";

export type {
  AgentAdapterType,
  GatewayDefinition,
  MessageAdapterPolicies,
  MessageAdapterPolicy,
  MessageAdapterType,
  MessagePayloadKind,
  NotificationScheduleDefinition,
  PipelineDefinition
} from "@shared/gatewayConfigModel";

export type NotificationRule = NotificationRuleDefinition;
export type NapCatInstance = NapCatInstanceDefinition;
export type OutputAdapterType = "qq" | "agent" | "file" | "console" | "tts" | "webhook" | "fennenote" | "wecom" | "none";
export type PromptOutputMode = "qq_text" | "voice_short" | "markdown" | "json" | "plain_text";
export type AgentMaturity = "verified" | "experimental" | "stub";

export type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
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
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};

export type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type AdapterInstallCandidate = {
  label: string;
  path?: string;
  url?: string;
};

export type MessageAdapterScanResult = {
  type: MessageAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: AdapterInstallCandidate[];
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
};

export type RoleOption = PersonaAvatarPresentation & {
  label: string;
  value: string;
  rolePath?: string;
  roleContent?: string;
  roleError?: string;
  dataDir?: string;
};

export type RuntimeStatus = GatewayDefinition & {
  running?: boolean;
  pid?: number | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
  } | null;
  roleInfo?: {
    rolesDir?: string;
    selectedRoleId?: string;
    selectedRolePath?: string;
    selectedRoleContent?: string;
    selectedRoleError?: string;
    selectedRoleDataDir?: string;
    options?: RoleOption[];
  };
  gatewayStatus?: Record<string, any>;
  adapterLogs?: Record<string, {
    paths?: string[];
    entries?: Array<Record<string, any>>;
  }>;
  messageFiles?: Record<string, {
    paths?: string[];
    entries?: Array<Record<string, any>>;
  }>;
  agentStates?: Partial<Record<AgentAdapterType, Record<string, any>>>;
  log?: string[];
};

export type GatewayPayload = {
  code: number;
  message?: string;
  data?: {
    config?: {
      gateways?: GatewayDefinition[];
    };
    configFiles?: Record<string, string>;
    manager?: RuntimeStatus[] | { error?: string };
  };
};

export type NetworkOptions = {
  adapters: Record<string, unknown>;
  localAddresses?: Array<{ name?: string; address: string; cidr?: string }>;
  httpServers: unknown[];
  websocketClients: unknown[];
};

export type MetaPayload = {
  version: string;
  githubUrl: string;
  managerPort: number;
  rabiGuid?: string;
  rabiName?: string;
  rabiLinkRelay?: {
    enabled?: boolean;
    url?: string;
    token?: string;
    tokenConfigured?: boolean;
    deviceId?: string;
    claimWaitMs?: number;
    replyIdleTimeoutMs?: number;
    speechProxyEnabled?: boolean;
    speechServiceUrl?: string;
  };
  rabiLinkRelayRuntime?: {
    state?: "disabled" | "incomplete" | "connecting" | "online" | "error";
    message?: string;
    lastConnectedAt?: string;
    lastSuccessAt?: string;
    error?: string;
  };
  computerName?: string;
};

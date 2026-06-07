export type MessageAdapterType = "napcat" | "heartbeat" | "fennenote" | "xiaoai" | "webhook" | "disabled";
export type AgentAdapterType = "codexDesktop" | "codexApp" | "copilotCli" | "marvis" | "astrbot";
export type OutputAdapterType = "qq" | "codex" | "file" | "console" | "tts" | "webhook" | "none";
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

export type PipelineDefinition = {
  id?: string;
  name?: string;
  inputAdapter?: MessageAdapterType;
  outputAdapter?: OutputAdapterType;
  outputPipeline?: string;
  promptOutputMode?: PromptOutputMode;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsWorkerUrl?: string;
  ttsPlay?: boolean;
  preventFeedbackLoop?: boolean;
  replyToSource?: boolean;
};

export type NotificationRule = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  regex?: string;
  template: string;
};

export type NapCatInstance = {
  id: string;
  name?: string;
  enabled?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
  botNickname?: string;
  connected?: boolean;
  remoteAddress?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  loginInfoError?: string;
};

export type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatInstances?: NapCatInstance[];
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  codexThreadName?: string;
  codexCwd?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  notificationRules?: NotificationRule[];
  roleNotificationRules?: Record<string, NotificationRule[]>;
  roleRouteNames?: Record<string, string>;
};

export type RoleOption = {
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
  codexState?: Record<string, any>;
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
  httpServers: unknown[];
  websocketClients: unknown[];
};

export type MetaPayload = {
  version: string;
  githubUrl: string;
  managerPort: number;
};

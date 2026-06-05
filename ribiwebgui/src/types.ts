export type MessageAdapterType = "napcat" | "heartbeat" | "webhook" | "disabled";
export type AgentAdapterType = "codexDesktop" | "codexApp";

export type NotificationRule = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  regex?: string;
  template: string;
};

export type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  napcatHttpUrl?: string;
  napcatAccessToken?: string;
  targetGroupId?: string;
  routeVariables?: Record<string, string>;
  routeName?: string;
  codexThreadName?: string;
  codexCwd?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  dataDir?: string;
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

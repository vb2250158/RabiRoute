export const REMOTE_AGENT_PROTOCOL_VERSION = 3;

export type RemoteAgentDeviceInfo = {
  deviceId: string;
  deviceName?: string;
  agentType?: string;
  agentTypes?: string[];
  os?: string;
  osVersion?: string;
  arch?: string;
  declaredIp?: string;
  defaultCwd?: string;
  defaultThreadName?: string;
};

export type RemoteAgentTaskRequest = {
  deviceId?: string;
  message?: string;
  text?: string;
  taskKind?: string;
  cwd?: string;
  threadName?: string;
  filePaths?: string[];
  files?: RemoteAgentFileTransfer[];
  attachments?: Array<RemoteAgentFileTransfer | { path?: string; name?: string; kind?: string }>;
  originGatewayId?: string;
  gatewayId?: string;
  originReplyContext?: Record<string, unknown>;
};

export type RemoteAgentFileTransfer = {
  name: string;
  relativePath?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  contentBase64?: string;
};

export type RemoteAgentTaskEvent = {
  taskId?: string;
  status?: "queued" | "delivered" | "started" | "progress" | "completed" | "failed";
  summary?: string;
  message?: string;
  artifactPath?: string;
  logPath?: string;
  files?: RemoteAgentFileTransfer[];
  savedFiles?: RemoteAgentFileTransfer[];
  error?: string;
  data?: unknown;
  device?: Partial<RemoteAgentDeviceInfo>;
};

export type RemoteAgentTask = {
  taskId: string;
  deviceId: string;
  message: string;
  taskKind: string;
  cwd?: string;
  threadName?: string;
  files: RemoteAgentFileTransfer[];
  originGatewayId: string;
  originReplyContext?: Record<string, unknown>;
  status: "queued" | "delivered" | "started" | "progress" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  events: RemoteAgentTaskEvent[];
};

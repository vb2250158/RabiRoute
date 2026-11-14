/** Percentage describes the current measurable phase, never estimated total time. */
export type HomeAssistantInstallProgress = Readonly<{
  phase: string;
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
}>;

export type HomeAssistantDeploymentConfig = Readonly<{
  mode: "external" | "docker" | "haos";
  containerName: string;
  autoStart: boolean;
  healthCheckIntervalMs?: number;
  recoveryCooldownMs?: number;
  recoveryMaxAttempts?: number;
}>;

/** Latest read-only observation; never evidence for publishing a transport endpoint. */
export type HomeAssistantOsDiagnostics = Readonly<{
  checkedAt: string;
  reason: "vm_not_found" | "vm_not_running" | "no_guest_address" | "core_unready" | "ready";
  vmState?: string;
  guestAddresses: readonly string[];
}>;

export type HomeAssistantDeploymentSnapshot = Readonly<{
  schemaVersion: 1;
  revision: string;
  configured: boolean;
  config: HomeAssistantDeploymentConfig;
  installation: "installed" | "not_found" | "unknown" | "external";
  state: "ready" | "stopped" | "starting" | "unavailable" | "error" | "installing" | "reboot_required";
  message: string;
  image?: string;
  containerId?: string;
  installationPath?: string;
  configPath?: string;
  baseUrl: string;
  canStart: boolean;
  canInstall?: boolean;
  haosInstallPath?: string;
  progress?: HomeAssistantInstallProgress;
  recoveryAttempts?: number;
  recoveryExhausted?: boolean;
  privilege?: "administrator" | "limited" | "unknown";
  diagnostics?: HomeAssistantOsDiagnostics;
}>;

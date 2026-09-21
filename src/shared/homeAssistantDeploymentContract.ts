export type HomeAssistantDeploymentConfig = Readonly<{
  mode: "external" | "docker" | "haos";
  containerName: string;
  autoStart: boolean;
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
}>;

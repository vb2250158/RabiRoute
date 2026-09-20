export type HomeAssistantDeploymentConfig = Readonly<{
  mode: "external" | "docker";
  containerName: string;
  autoStart: boolean;
}>;

export type HomeAssistantDeploymentSnapshot = Readonly<{
  schemaVersion: 1;
  revision: string;
  configured: boolean;
  config: HomeAssistantDeploymentConfig;
  installation: "installed" | "not_found" | "unknown" | "external";
  state: "ready" | "stopped" | "starting" | "unavailable" | "error";
  message: string;
  image?: string;
  containerId?: string;
  installationPath?: string;
  configPath?: string;
  baseUrl: string;
  canStart: boolean;
}>;

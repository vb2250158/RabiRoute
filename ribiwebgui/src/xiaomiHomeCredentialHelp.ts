export const HOME_ASSISTANT_AUTHENTICATION_DOCS_URL = "https://www.home-assistant.io/docs/authentication/";
export const HOME_ASSISTANT_INSTALLATION_URL = "https://www.home-assistant.io/installation/";
export const HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL = "https://github.com/XiaoMi/ha_xiaomi_home/blob/main/doc/README_zh.md";

type HomeAssistantDeploymentView = Readonly<{
  config: Readonly<{ mode: "haos" | "docker" | "external" }>;
  state: string;
  baseUrl: string;
}>;

function homeAssistantUrl(baseUrl: string, pathname: string): string {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function homeAssistantLoginUrl(baseUrl: string): string {
  return homeAssistantUrl(baseUrl, "/");
}

export function homeAssistantProfileUrl(baseUrl: string): string {
  return homeAssistantUrl(baseUrl, "/profile/security");
}

/** Display the managed listener without changing the stored credential origin. */
export function homeAssistantEndpointPresentation(deployment: HomeAssistantDeploymentView | undefined, draftBaseUrl: string, savedBaseUrl: string) {
  const managed = deployment?.config.mode === "haos";
  const address = managed ? deployment.baseUrl || "" : draftBaseUrl;
  const loginUrl = homeAssistantLoginUrl(address);
  const profileUrl = homeAssistantProfileUrl(address);
  const serviceReady = Boolean(deployment && deployment.state === "ready" && loginUrl
    && (managed || homeAssistantLoginUrl(deployment.baseUrl) === loginUrl));
  return { managed, address, loginUrl, profileUrl, serviceReady,
    credentialBaseUrl: managed ? savedBaseUrl : draftBaseUrl };
}

import { getTimeoutMs } from "../timeoutSettingsClient";
import { remotePersonaClient } from "./remotePersonaReference";

export async function loadPersonaDocument(roleId: string, fileName = "persona.md", deviceId = ""): Promise<string> {
  if (deviceId) return (await remotePersonaClient.reference(deviceId, roleId, fileName)).document;
  const query = new URLSearchParams({ file: fileName });
  const signal = AbortSignal.timeout(getTimeoutMs("webgui.persona.document", 25000));
  const path = `/api/roles/${encodeURIComponent(roleId)}/persona-document?${query}`;
  const response = await fetch(path,
    { signal, redirect: "error" });
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `角色正文读取失败（HTTP ${response.status}）。`);
  }
  return response.text();
}

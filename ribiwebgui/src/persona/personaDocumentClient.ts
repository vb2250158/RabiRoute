import { PERSONA_DOCUMENT_MAX_BYTES, responseTextByByteLimit } from "../markdownPreview";
import { remotePersonaClient } from "./remotePersonaReference";

export async function loadPersonaDocument(roleId: string, fileName = "persona.md", deviceId = ""): Promise<string> {
  if (deviceId) return (await remotePersonaClient.reference(deviceId, roleId, fileName)).document;
  const query = new URLSearchParams({ file: fileName });
  const signal = AbortSignal.timeout(25_000);
  const path = `/api/roles/${encodeURIComponent(roleId)}/persona-document?${query}`;
  const response = await fetch(path,
    { signal, redirect: "error" });
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `人格正文读取失败（HTTP ${response.status}）。`);
  }
  const document = await responseTextByByteLimit(
    response,
    PERSONA_DOCUMENT_MAX_BYTES,
    false,
    `人格正文超过 ${PERSONA_DOCUMENT_MAX_BYTES} 字节。`
  );
  return document;
}

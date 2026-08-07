import { PERSONA_DOCUMENT_MAX_BYTES, responseTextByByteLimit } from "../markdownPreview";

export async function loadPersonaDocument(roleId: string, fileName = "persona.md"): Promise<string> {
  const query = new URLSearchParams({ file: fileName });
  const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/persona-document?${query}`);
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `人格正文读取失败（HTTP ${response.status}）。`);
  }
  return responseTextByByteLimit(
    response,
    PERSONA_DOCUMENT_MAX_BYTES,
    false,
    `人格正文超过 ${PERSONA_DOCUMENT_MAX_BYTES} 字节。`
  );
}

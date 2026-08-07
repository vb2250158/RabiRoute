import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const PERSONA_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

function textResponse(response: http.ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(message);
}

export function handlePersonaDocumentApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  roleDir: (roleId: string) => string
): boolean {
  const match = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/persona-document$/);
  if (!match || request.method !== "GET") return false;

  let roleId = "";
  try {
    roleId = decodeURIComponent(match[1] || "");
  } catch {
    textResponse(response, 400, "Invalid role id.");
    return true;
  }

  const fileName = requestUrl.searchParams.get("file")?.trim() || "persona.md";
  if (path.basename(fileName) !== fileName || !/\.(?:md|markdown)$/i.test(fileName)) {
    textResponse(response, 400, "Persona document must be one Markdown file name.");
    return true;
  }

  try {
    const resolvedRoleDir = path.resolve(roleDir(roleId));
    const targetPath = path.resolve(resolvedRoleDir, fileName);
    if (path.dirname(targetPath) !== resolvedRoleDir) {
      textResponse(response, 400, "Persona document path leaves the role directory.");
      return true;
    }
    if (!fs.existsSync(targetPath)) {
      textResponse(response, 404, "Persona document was not found.");
      return true;
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      textResponse(response, 400, "Persona document is not a file.");
      return true;
    }
    if (stat.size > PERSONA_DOCUMENT_MAX_BYTES) {
      textResponse(response, 413, `Persona document exceeds ${PERSONA_DOCUMENT_MAX_BYTES} bytes.`);
      return true;
    }
    const realRoleDir = fs.realpathSync(resolvedRoleDir);
    const realTargetPath = fs.realpathSync(targetPath);
    if (path.dirname(realTargetPath) !== realRoleDir) {
      textResponse(response, 403, "Persona document resolves outside the role directory.");
      return true;
    }
    response.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-length": stat.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(fs.readFileSync(realTargetPath));
  } catch (error) {
    textResponse(response, 400, error instanceof Error ? error.message : String(error));
  }
  return true;
}

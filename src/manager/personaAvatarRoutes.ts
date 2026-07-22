import fs from "node:fs";
import http from "node:http";
import {
  readPersonaAvatar,
  removePersonaAvatar,
  savePersonaAvatar
} from "../personaAvatar.js";
import {
  PERSONA_AVATAR_MAX_BYTES,
  type PersonaAvatarMutationResult,
  type PersonaAvatarPresentation
} from "../shared/personaAvatarContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";

class PersonaAvatarRouteError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function avatarUrl(roleId: string, version: string | undefined): string | undefined {
  return version
    ? `/api/roles/${encodeURIComponent(roleId)}/avatar?v=${encodeURIComponent(version)}`
    : undefined;
}

function readLimitedBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > PERSONA_AVATAR_MAX_BYTES) {
        rejectOnce(new PersonaAvatarRouteError(413, "Avatar image exceeds the 5 MB limit."));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", rejectOnce);
  });
}

function mutationResult(roleId: string, version: string | undefined): PersonaAvatarMutationResult {
  const url = avatarUrl(roleId, version);
  return { configured: Boolean(url), ...(url ? { avatarUrl: url } : {}) };
}

export function personaAvatarPresentation(roleId: string, roleDir: string): PersonaAvatarPresentation {
  const avatar = readPersonaAvatar(roleDir);
  const url = avatarUrl(roleId, avatar.version);
  return {
    avatarConfigured: avatar.configured,
    ...(url ? { avatarUrl: url } : {})
  };
}

export function handlePersonaAvatarApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  rolesRoot: string
): boolean {
  const match = pathname.match(/^\/api\/roles\/([^/]+)\/avatar$/);
  if (!match) return false;
  const roleId = sanitizeRoleId(decodeURIComponent(match[1]));
  if (!roleId) {
    jsonResponse(response, 400, { code: -1, message: "Invalid role id." });
    return true;
  }
  const roleDir = roleFolderPath(rolesRoot, roleId);

  if (request.method === "GET") {
    const avatar = readPersonaAvatar(roleDir);
    if (!avatar.filePath || !avatar.contentType) {
      jsonResponse(response, 404, { code: -1, message: "Persona avatar is not configured." });
      return true;
    }
    try {
      response.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(fs.statSync(avatar.filePath).size),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff"
      });
      fs.createReadStream(avatar.filePath).pipe(response);
    } catch (error) {
      jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "PUT") {
    const contentType = String(request.headers["content-type"] || "");
    void readLimitedBody(request)
      .then(body => savePersonaAvatar(roleDir, contentType, body))
      .then(avatar => jsonResponse(response, 200, { code: 0, data: mutationResult(roleId, avatar.version) }))
      .catch(error => jsonResponse(response, error instanceof PersonaAvatarRouteError ? error.statusCode : 400, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (request.method === "DELETE") {
    try {
      removePersonaAvatar(roleDir);
      jsonResponse(response, 200, { code: 0, data: mutationResult(roleId, undefined) });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
  return true;
}

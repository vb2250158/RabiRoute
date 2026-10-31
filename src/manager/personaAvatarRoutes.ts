import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { finished } from "node:stream/promises";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";
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

function avatarUrl(roleId: string, version: string | undefined): string | undefined {
  return version
    ? `/api/roles/${encodeURIComponent(roleId)}/avatar?v=${encodeURIComponent(version)}`
    : undefined;
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
    ...(url ? { avatarUrl: url } : {}),
    ...(avatar.version ? { avatarVersion: avatar.version } : {})
  };
}

export type PersonaAvatarChanged = { roleId: string; avatarUrl?: string; avatarVersion?: string };

export const PERSONA_AVATAR_FRAME_BYTES = 64 * 1024;
export function createPersonaAvatarOwner(options: { rolesRoot: string; identity?(): PersonaResourceIdentity; onChanged?(change: PersonaAvatarChanged): void }) {
  return {
    prepare(request: http.IncomingMessage, rawRoleId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, options.identity);
      const roleId = sanitizeRoleId(rawRoleId);
      if (!roleId) throw Object.assign(new Error("Invalid role id."), { statusCode: 400 });
      const roleDir = roleFolderPath(options.rolesRoot, roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(roleFolderPath(options.rolesRoot, roleId)) !== path.resolve(roleDir)) {
          throw Object.assign(new Error("Persona directory changed while using the original resource."), { statusCode: 409 });
        }
      };
      return {
        read() {
          assertCurrent();
          const avatar = readPersonaAvatar(roleDir);
          if (!avatar.filePath || !avatar.contentType) throw Object.assign(new Error("Persona avatar is not configured."), { statusCode: 404 });
          const descriptor = fs.openSync(avatar.filePath, "r");
          let stream: fs.ReadStream;
          try {
            const stat = fs.fstatSync(descriptor); if (!stat.isFile()) throw new Error("Persona avatar is not a file.");
            stream = fs.createReadStream(avatar.filePath, { fd: descriptor, autoClose: true, highWaterMark: PERSONA_AVATAR_FRAME_BYTES, signal });
            const closed = finished(stream).catch(() => {});
            const frames = (async function* () { try { for await (const chunk of stream) { assertCurrent(); yield Buffer.from(chunk); } } finally { stream.destroy(); await closed; } })();
            return { contentType: avatar.contentType, sizeBytes: stat.size, frames, async cancel() { stream.destroy(); await closed; } };
          } catch (error) { fs.closeSync(descriptor); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { statusCode: 404 }); }
        },
        async save(contentType: string, body: http.IncomingMessage) {
          const bytes = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []; let size = 0;
            const cleanup = () => { body.removeListener('data', data); body.removeListener('end', ended); body.removeListener('error', failed); body.removeListener('aborted', aborted); signal?.removeEventListener('abort', aborted); };
            const failed = (error: unknown) => { cleanup(); body.once('error', () => {}); body.resume(); reject(error); };
            const aborted = () => failed(signal?.reason ?? new Error('Avatar upload aborted.'));
            const data = (chunk: Buffer) => { try { assertCurrent(); size += chunk.length; if (size > PERSONA_AVATAR_MAX_BYTES) throw Object.assign(new Error('Avatar image exceeds the 5 MB limit.'), { statusCode: 413 }); chunks.push(Buffer.from(chunk)); } catch (error) { failed(error); } };
            const ended = () => { cleanup(); resolve(Buffer.concat(chunks)); };
            body.on('data', data); body.once('end', ended); body.once('error', failed); body.once('aborted', aborted); signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted || body.aborted) aborted();
          });
          assertCurrent(); const avatar = savePersonaAvatar(roleDir, contentType, bytes);
          const url = avatarUrl(roleId, avatar.version);
          try { options.onChanged?.({ roleId, ...(url ? { avatarUrl: url } : {}), ...(avatar.version ? { avatarVersion: avatar.version } : {}) }); assertCurrent(); }
          catch (error) { if (error && typeof error === 'object') Object.assign(error, { uncertain: true }); throw error; }
          return mutationResult(roleId, avatar.version);
        },
        remove() {
          assertCurrent(); removePersonaAvatar(roleDir);
          try { options.onChanged?.({ roleId }); assertCurrent(); }
          catch (error) { if (error && typeof error === 'object') Object.assign(error, { uncertain: true }); throw error; }
          return mutationResult(roleId, undefined);
        }
      };
    }
  };
}

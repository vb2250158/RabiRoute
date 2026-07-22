import {
  PERSONA_AVATAR_CONTENT_TYPES,
  PERSONA_AVATAR_MAX_BYTES,
  type PersonaAvatarMutationResult
} from "@shared/personaAvatarContract";

type PersonaAvatarEnvelope = {
  code?: number;
  message?: string;
  data?: PersonaAvatarMutationResult;
};

function avatarEndpoint(roleId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}/avatar`;
}

async function mutationRequest(roleId: string, init: RequestInit): Promise<PersonaAvatarMutationResult> {
  const response = await fetch(avatarEndpoint(roleId), init);
  const body = await response.json().catch(() => ({})) as PersonaAvatarEnvelope;
  if (!response.ok || body.code !== 0 || !body.data) {
    throw new Error(body.message || `Persona avatar request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

export const personaAvatarClient = {
  upload(roleId: string, file: File): Promise<PersonaAvatarMutationResult> {
    if (!PERSONA_AVATAR_CONTENT_TYPES.some(contentType => contentType === file.type)) {
      throw new Error("头像必须是 PNG、JPEG、WebP 或 GIF。");
    }
    if (file.size > PERSONA_AVATAR_MAX_BYTES) {
      throw new Error("头像不能超过 5 MB。");
    }
    return mutationRequest(roleId, {
      method: "PUT",
      headers: { "content-type": file.type },
      body: file
    });
  },

  remove(roleId: string): Promise<PersonaAvatarMutationResult> {
    return mutationRequest(roleId, { method: "DELETE" });
  }
};

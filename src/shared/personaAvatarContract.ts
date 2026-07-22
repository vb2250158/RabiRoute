export const PERSONA_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const PERSONA_AVATAR_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

export type PersonaAvatarContentType = typeof PERSONA_AVATAR_CONTENT_TYPES[number];

export const PERSONA_AVATAR_ACCEPT = PERSONA_AVATAR_CONTENT_TYPES.join(",");

export type PersonaAvatarPresentation = {
  avatarConfigured: boolean;
  avatarUrl?: string;
};

export type PersonaAvatarMutationResult = {
  configured: boolean;
  avatarUrl?: string;
};

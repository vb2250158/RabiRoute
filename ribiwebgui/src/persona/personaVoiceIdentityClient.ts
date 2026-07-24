export type PersonaVoiceClassification = "user" | "other" | "unknown" | "conflict";

export type PersonaVoiceClassificationStats = {
  records: number;
  segments: number;
  speakerDurationSeconds: number;
};

export type PersonaVoiceUnresolvedVoiceprint = {
  sourceHostId?: string;
  sourceHostName?: string;
  voiceprintId: string;
  classification: "unknown" | "conflict";
  segments: number;
  speakerDurationSeconds: number;
  lastSeenAt: string;
};

export type PersonaVoiceTranscriptSummary = {
  recordCount: number;
  mixedRecordCount: number;
  segmentCount: number;
  recordingDurationSeconds: number;
  speakerDurationSeconds: number;
  classifiedSpeakerDurationSeconds: number;
  coverageRate: number;
  byClassification: Record<PersonaVoiceClassification, PersonaVoiceClassificationStats>;
  unresolvedVoiceprints: PersonaVoiceUnresolvedVoiceprint[];
};

export type PersonaVoiceIdentity = {
  identityKey: string;
  sourceHostId: string;
  sourceHostName?: string;
  voiceprintId: string;
  displayName?: string;
  relationship?: string;
  isUser?: boolean;
  aliases: string[];
  notes?: string;
  updatedAt: string;
  conflicted?: boolean;
  conflictFields?: string[];
};

export type PersonaVoiceSummaryResult = {
  identityPath: string;
  conversationPath: string;
  matchedCount: number;
  items: [];
  summary: PersonaVoiceTranscriptSummary;
};

export type PersonaVoiceIdentityListResult = {
  path: string;
  identities: PersonaVoiceIdentity[];
};

export type PersonaVoiceIdentityPatch = {
  sourceHostId: string;
  sourceHostName?: string;
  voiceprintId: string;
  isUser: boolean | null;
};

export type PersonaVoiceIdentityMutationResult = {
  identity?: PersonaVoiceIdentity;
  appended: boolean;
  deleted: boolean;
};

type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

function roleEndpoint(roleId: string, suffix: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}/${suffix}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || body.code !== 0 || body.data == null) {
    throw new Error(body.message || `Persona voice request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

export const personaVoiceIdentityClient = {
  summary(roleId: string, from: string, to: string): Promise<PersonaVoiceSummaryResult> {
    const query = new URLSearchParams({
      from,
      to,
      includeArchives: "true",
      includeDetails: "false"
    });
    return request<PersonaVoiceSummaryResult>(`${roleEndpoint(roleId, "voice-transcripts")}?${query}`);
  },

  identities(roleId: string): Promise<PersonaVoiceIdentityListResult> {
    return request<PersonaVoiceIdentityListResult>(roleEndpoint(roleId, "voice-identities"));
  },

  update(roleId: string, patch: PersonaVoiceIdentityPatch): Promise<PersonaVoiceIdentityMutationResult> {
    return request<PersonaVoiceIdentityMutationResult>(roleEndpoint(roleId, "voice-identities"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
  }
};

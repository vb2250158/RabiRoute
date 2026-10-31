import type http from "node:http";
import path from "node:path";
import { type PersonaVoiceTranscriptQuery, type PersonaVoiceTranscriptQueryResult, type PersonaVoiceSpeakerClassification } from "../personaVoiceTranscriptView.js";
import { managerReadWorkerPool } from "./managerReadWorkerPool.js";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";

export type PersonaVoiceTranscriptRouteContext = {
  roleDir(roleId: string): string;
  identity?(): PersonaResourceIdentity;
  query?(roleDir: string, query: PersonaVoiceTranscriptQuery, signal: AbortSignal): Promise<PersonaVoiceTranscriptQueryResult>;
};

export function createPersonaVoiceTranscriptOwner(context: PersonaVoiceTranscriptRouteContext) {
  return {
    prepare(request: http.IncomingMessage, roleId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, context.identity);
      const roleDir = context.roleDir(roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(context.roleDir(roleId)) !== path.resolve(roleDir)) throw Object.assign(new Error('Persona directory changed while reading original voice transcripts.'), { statusCode: 409 });
      };
      return {
        async read(parameters: URLSearchParams) {
          assertCurrent();
          const rawSpeaker = parameters.get('speaker')?.trim() || '';
          const rawIncludeDetails = parameters.get('includeDetails')?.trim().toLowerCase();
          const speakers = new Set<PersonaVoiceSpeakerClassification>(['user','other','unknown','conflict']);
          if (rawSpeaker && !speakers.has(rawSpeaker as PersonaVoiceSpeakerClassification)) throw new Error('speaker must be user, other, unknown, or conflict.');
          const query: PersonaVoiceTranscriptQuery = {
            limit: Number(parameters.get('limit') || 200),
            includeArchives: ['1','true','yes'].includes((parameters.get('includeArchives') || '').toLowerCase()),
            includeDetails: rawIncludeDetails == null || !['0','false','no'].includes(rawIncludeDetails),
            speaker: rawSpeaker ? rawSpeaker as PersonaVoiceSpeakerClassification : undefined,
            from: parameters.get('from') || undefined, to: parameters.get('to') || undefined
          };
          const execute = context.query ?? ((directory, input, cancel) => managerReadWorkerPool.queryPersonaVoiceTranscripts(directory,input,{signal:cancel}));
          const result = await execute(roleDir,query,signal ?? new AbortController().signal);
          assertCurrent();
          return { identityPath:'voice/voice-identities.jsonl',conversationPath:'conversation/current.jsonl',...result };
        }
      };
    }
  };
}

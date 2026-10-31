import type http from "node:http";
import { readPersonaChatHistory, appendPersonaAiuiExchange } from "../personaChatHistory.js";
import { enrichPersonaChatTasks, type PersonaChatTaskMetadataContext } from "./personaChatTaskMetadata.js";

import path from "node:path";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";

export type PersonaChatHistoryContext = PersonaChatTaskMetadataContext & {
  roleDir(roleId: string): string;
  identity?(): PersonaResourceIdentity;
  read?: typeof readPersonaChatHistory;
  append?: typeof appendPersonaAiuiExchange;
};

export function createPersonaChatHistoryOwner(context: PersonaChatHistoryContext) {
  return {
    prepare(request: http.IncomingMessage, roleId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, context.identity);
      const roleDir = context.roleDir(roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(context.roleDir(roleId)) !== path.resolve(roleDir)) throw Object.assign(new Error('Persona directory changed while using the original chat history.'), { statusCode: 409 });
      };
      return {
        async read(cursor: number | undefined, limit: number, options: Parameters<typeof readPersonaChatHistory>[3] = {}) {
          assertCurrent();
          const data = await (context.read ?? readPersonaChatHistory)(roleDir, cursor, limit, options);
          assertCurrent();
          data.entries = await enrichPersonaChatTasks(data.entries, context);
          assertCurrent(); return data;
        },
        async append(raw: unknown) {
          assertCurrent();
          const body = raw as { sessionId: string; turnId: string; userText: string; assistantText?: string | null };
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sessionId', 'turnId', 'userText', 'assistantText'].includes(key))
        || ![body.sessionId, body.turnId].every(value => typeof value === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(value))
        || typeof body.userText !== 'string' || !body.userText.trim() || body.userText.length > 16000
        || (body.assistantText !== undefined && body.assistantText !== null && (typeof body.assistantText !== 'string' || body.assistantText.length > 16000))) throw new Error('AIUI_BODY_INVALID');
          const receipt = await (context.append ?? appendPersonaAiuiExchange)(roleDir, body, assertCurrent);
          try { assertCurrent(); }
          catch (error) { if (error && typeof error === 'object') Object.assign(error, { uncertain: true }); throw error; }
          return receipt;
        }
      };
    }
  };
}

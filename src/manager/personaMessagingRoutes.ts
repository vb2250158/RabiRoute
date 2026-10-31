import { ApiContractError, type ApiOperationDefinition, type ApiOperationInput, type ApiSchema } from "./apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { rolePanelMessageSchema } from "./rolePanelMessageContract.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import { validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import path from "node:path";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { routeRuntimeParts, sanitizeRoleId } from "../shared/routeIdentity.js";
import type {
  RolePanelAttachment,
  RolePanelTimelineAppendResult,
  RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import type { PersonaMessageReplyContext } from "../shared/rolePanelMessage.js";
import {
  executeDurableDelivery,
  DURABLE_DELIVERY_RECEIPT_STATES,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";
import { deliverRolePanelMessage, RolePanelDeliveryError } from "./rolePanelDelivery.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type PersonaMessagingRuntime = GatewayRuntime;

export type PersonaMessageDelivery = (
  runtime: PersonaMessagingRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext: Record<string, unknown>
) => Promise<void>;

export type PersonaMessagingRouteContext = {
  rootDir: string;
  rolesRoot: string;
  personaPresentations: () => readonly RouteCatalogPersonaPresentation[];
  runtimes: () => PersonaMessagingRuntime[];
  authorizeSource: (routeId: string, personaId: string, capability: string) => boolean;
  deliver: PersonaMessageDelivery;
  appendTimeline: (roleId: string, message: RolePanelTimelineMessage) => Promise<RolePanelTimelineAppendResult>;
};

export type PersonaRouteSummary = {
  routeId: string;
  name: string;
  enabled: boolean;
  running: boolean;
};

export type PersonaSummary = {
  personaId: string;
  name: string;
  title: string;
  addressable: boolean;
  defaultRouteId?: string;
  routes: PersonaRouteSummary[];
};

type PersonaMessageRequest = {
  deliveryId?: string;
  sourceRouteId?: string;
  sourceCapability?: string;
  targetRouteId?: string;
  conversationId?: string;
  inReplyToMessageId?: string;
  hopCount?: number;
  text?: string;
};

type PreparedPersonaMessage = {
  sourceRouteId: string;
  sourcePersonaId: string;
  sourcePersona: PersonaSummary;
  targetPersonaId: string;
  target: PersonaMessagingRuntime;
  targetRouteId: string;
  conversationId: string;
  inReplyToMessageId?: string;
  hopCount: number;
  text: string;
};

export const PERSONA_MESSAGE_LIMITS = Object.freeze({ requestBytes: 65_536, textChars: 32_768, referenceChars: 200, maxHops: 8 });

class PersonaMessagingError extends Error {
  constructor(readonly statusCode: number, message: string, readonly delivery?: { uncertain: true; messageId: string; replyContext: Record<string, unknown> }) {
    super(message);
  }
}

function personaIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function routeSummary(runtime: PersonaMessagingRuntime): PersonaRouteSummary {
  return {
    routeId: runtime.definition.id,
    name: String(runtime.definition.routeName || runtime.definition.name || runtime.definition.id),
    enabled: runtime.definition.enabled === true,
    running: Boolean(runtime.process)
  };
}

function rolesRootKey(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

export function listPersonas(context: Pick<PersonaMessagingRouteContext, "rolesRoot" | "runtimes" | "personaPresentations">): PersonaSummary[] {
  const runtimes = context.runtimes();
  const activeRoot = rolesRootKey(context.rolesRoot);
  return context.personaPresentations()
    .filter(item => item.isPersona && !item.archivedAt && !item.lifecycleError && rolesRootKey(item.rolesRoot) === activeRoot)
    .map((item) => {
      const personaId = item.roleId;
      const title = item.files.find(file => file.fileName.toLowerCase() === "persona.md")?.title ?? "";
      const matchingRuntimes = runtimes.filter(runtime => !runtime.definition.agentRoleDeviceId
        && personaIdForDefinition(runtime.definition) === personaId);
      const routes = matchingRuntimes.map(routeSummary)
        .sort((left, right) => left.routeId.localeCompare(right.routeId));
      const enabledRoutes = routes.filter(route => route.enabled);
      return {
        personaId,
        name: title || routes[0]?.name || item.displayName || personaId,
        title,
        addressable: enabledRoutes.length > 0,
        defaultRouteId: enabledRoutes.length === 1 ? enabledRoutes[0].routeId : undefined,
        routes
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function resolvePersona(personaId: string, personas: PersonaSummary[]): PersonaSummary {
  const persona = personas.find(item => item.personaId === personaId);
  if (!persona) throw new PersonaMessagingError(404, `Persona not found: ${personaId}`);
  return persona;
}

function enabledRuntime(routeId: string, context: PersonaMessagingRouteContext): PersonaMessagingRuntime {
  const runtime = context.runtimes().find(item => item.definition.id === routeId);
  if (!runtime) throw new PersonaMessagingError(404, `Route not found: ${routeId}`);
  if (runtime.definition.enabled !== true) throw new PersonaMessagingError(409, `Route is not enabled: ${routeId}`);
  return runtime;
}

function targetRuntime(
  persona: PersonaSummary,
  targetRouteId: string,
  context: PersonaMessagingRouteContext
): PersonaMessagingRuntime {
  const enabledRoutes = persona.routes.filter(route => route.enabled);
  if (enabledRoutes.length === 0) {
    throw new PersonaMessagingError(409, `Persona has no enabled Route: ${persona.personaId}`);
  }
  if (!targetRouteId && enabledRoutes.length > 1) {
    throw new PersonaMessagingError(409, `Persona has multiple enabled Routes; provide targetRouteId: ${persona.personaId}`);
  }
  const routeId = targetRouteId || enabledRoutes[0].routeId;
  if (!enabledRoutes.some(route => route.routeId === routeId)) {
    throw new PersonaMessagingError(409, `Route is not an enabled target for persona ${persona.personaId}: ${routeId}`);
  }
  return enabledRuntime(routeId, context);
}

function preparePersonaMessage(
  targetPersonaId: string,
  body: PersonaMessageRequest,
  context: PersonaMessagingRouteContext
): PreparedPersonaMessage {
  const sourceRouteId = String(body.sourceRouteId || "").trim();
  if (!sourceRouteId) throw new PersonaMessagingError(400, "Missing sourceRouteId.");
  const sourceRuntime = enabledRuntime(sourceRouteId, context);
  if (sourceRuntime.definition.agentRoleDeviceId) {
    throw new PersonaMessagingError(409, "Remote persona messages must use the target PC's persona interface.");
  }
  const sourcePersonaId = personaIdForDefinition(sourceRuntime.definition);
  const sourceCapability = String(body.sourceCapability || "").trim();
  if (!sourceCapability || !context.authorizeSource(sourceRouteId, sourcePersonaId, sourceCapability)) {
    throw new PersonaMessagingError(403, "The source Route capability is missing or invalid.");
  }
  const personas = listPersonas(context);
  const sourcePersona = resolvePersona(sourcePersonaId, personas);
  const targetPersona = resolvePersona(targetPersonaId, personas);
  if (sourcePersonaId === targetPersonaId) {
    throw new PersonaMessagingError(409, "Cross-persona messaging cannot target the source persona.");
  }

  const text = String(body.text || "").trim();
  if (!text) throw new PersonaMessagingError(400, "Missing message text.");
  if (text.length > PERSONA_MESSAGE_LIMITS.textChars) throw new PersonaMessagingError(413, `Message text exceeds ${PERSONA_MESSAGE_LIMITS.textChars} characters.`);
  const target = targetRuntime(targetPersona, String(body.targetRouteId || "").trim(), context);
  const conversationId = String(body.conversationId || "").trim() || `persona:${normalizeDurableDeliveryId(body.deliveryId)}`;
  if (conversationId.length > PERSONA_MESSAGE_LIMITS.referenceChars) throw new PersonaMessagingError(400, `conversationId exceeds ${PERSONA_MESSAGE_LIMITS.referenceChars} characters.`);
  const inReplyToMessageId = String(body.inReplyToMessageId || "").trim() || undefined;
  if (inReplyToMessageId && inReplyToMessageId.length > PERSONA_MESSAGE_LIMITS.referenceChars) {
    throw new PersonaMessagingError(400, `inReplyToMessageId exceeds ${PERSONA_MESSAGE_LIMITS.referenceChars} characters.`);
  }
  const hopCount = body.hopCount == null ? 0 : Number(body.hopCount);
  if (!Number.isInteger(hopCount) || hopCount < 0) throw new PersonaMessagingError(400, "hopCount must be a non-negative integer.");
  if (hopCount > PERSONA_MESSAGE_LIMITS.maxHops) {
    throw new PersonaMessagingError(409, `Cross-persona message hopCount exceeds ${PERSONA_MESSAGE_LIMITS.maxHops}.`);
  }
  return {
    sourceRouteId,
    sourcePersonaId,
    sourcePersona,
    targetPersonaId,
    target: { ...target, definition: structuredClone(target.definition) },
    targetRouteId: target.definition.id,
    conversationId,
    inReplyToMessageId,
    hopCount,
    text
  };
}

async function deliverPersonaMessage(
  prepared: PreparedPersonaMessage,
  context: PersonaMessagingRouteContext
): Promise<Record<string, unknown>> {
  const {
    sourceRouteId,
    sourcePersonaId,
    sourcePersona,
    targetPersonaId,
    target,
    targetRouteId,
    conversationId,
    inReplyToMessageId,
    hopCount,
    text
  } = prepared;
  const personaReplyContext: PersonaMessageReplyContext = {
    crossPersona: true,
    sourcePersonaId,
    sourcePersonaName: sourcePersona.name,
    sourceRouteId,
    targetPersonaId,
    targetRouteId,
    personaConversationId: conversationId,
    inReplyToPersonaMessageId: inReplyToMessageId,
    personaMessageHopCount: hopCount,
    personaMessageMaxHops: PERSONA_MESSAGE_LIMITS.maxHops
  };
  try {
    const delivery = await deliverRolePanelMessage({
      runtime: target,
      roleId: targetPersonaId,
      sender: sourcePersona.name,
      text,
      attachments: [],
      messageIdPrefix: "persona-message",
      replyContext: personaReplyContext,
      deliver: context.deliver,
      appendTimeline: context.appendTimeline
    });
    return {
      status: delivery.status,
      sourcePersonaId,
      sourceRouteId,
      targetPersonaId,
      targetRouteId,
      conversationId,
      hopCount,
      timelineRecorded: delivery.timelineRecorded,
      message: delivery.message
    };
  } catch (error) {
    if (error instanceof RolePanelDeliveryError) throw new PersonaMessagingError(error.statusCode, error.message, { uncertain: true, messageId: error.messageId, replyContext: error.replyContext });
    throw error;
  }
}

const personaRouteSummarySchema = { type: "object", required: ["routeId", "name", "enabled", "running"], additionalProperties: false,
  properties: { routeId: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, running: { type: "boolean" } } } as const;
const personaSummarySchema = { type: "object", required: ["personaId", "name", "title", "addressable", "routes"], additionalProperties: false,
  properties: { personaId: { type: "string" }, name: { type: "string" }, title: { type: "string" }, addressable: { type: "boolean" }, defaultRouteId: { type: "string" }, routes: { type: "array", items: personaRouteSummarySchema } } } as const;

export function createPersonaDirectoryOperation(context: () => Pick<PersonaMessagingRouteContext, "rolesRoot" | "runtimes" | "personaPresentations">): ApiOperationDefinition {
  return { contract: { operationId: "manager.personas.list", aliases: ["agent:GET:/api/personas"], contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/personas", exposure: "public", transport: "http",
    description: "Read the original persona presentation directory and enabled local Route reachability without a persona permission grant.",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: true, properties: { addressable: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } } }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "personas"], additionalProperties: false, properties: { code: { const: 0 }, personas: { type: "array", items: personaSummarySchema } } } },
      "500": { mediaType: "application/json", schema: { type: "object", required: ["code", "message"], additionalProperties: true, properties: { code: { const: -1 }, message: { type: "string" } } } } },
    effects: { mode: "read", description: "Reads the current presentation catalog and runtime state; it neither starts Routes nor delivers prompts." },
    recovery: { strategy: "repeatable-read", description: "Repeat the same query after the original catalog owner recovers." },
    validators: [{ id: "persona-directory-native-projection", description: "Keep only persona presentations in the original normalized roles root. Exclude remote-owned routes from local reachability; preserve names, sorting and the unique-enabled-route default. Only the first addressable query value equal to the exact string true filters results. Unknown query fields retain native ignored behavior." }]
  }, handler: input => {
    try { const addressableOnly = input.url.searchParams.get("addressable") === "true";
      return { status: 200, body: { code: 0, personas: listPersonas(context()).filter(persona => !addressableOnly || persona.addressable) } };
    } catch (error) { return { status: 500, body: errorResponsePresentation({ code: -1, message: error instanceof Error ? error.message : String(error) }, 500) }; }
  } };
}

const personaMessageRequestFields: Readonly<Record<string, ApiSchema>> = {
  deliveryId: { description: "Required stable delivery ID, validated by the native durable-delivery normalizer; retain it for original-receipt recovery." },
  sourceRouteId: { description: "Required enabled local source Route; native String(value || '').trim() normalization." },
  sourceCapability: { description: "Required original source-Route/persona proof from replyContext, rechecked before dispatch; connection authentication is independent." },
  targetRouteId: { description: "Optional only when the target persona has exactly one enabled local Route; retain native String normalization." },
  conversationId: { description: `Native String normalization; defaults to persona:<deliveryId>; at most ${PERSONA_MESSAGE_LIMITS.referenceChars} UTF-16 code units.` },
  inReplyToMessageId: { description: `Optional native String normalization; at most ${PERSONA_MESSAGE_LIMITS.referenceChars} UTF-16 code units.` },
  hopCount: { description: `Null/absent defaults to 0; otherwise native Number conversion, requiring an integer from 0 through ${PERSONA_MESSAGE_LIMITS.maxHops}.` },
  text: { description: `Native String(value || '').trim(); nonempty and at most ${PERSONA_MESSAGE_LIMITS.textChars} UTF-16 code units after trimming.` }
};

const idempotencySchema = { type: "object", required: ["deliveryId", "state", "duplicate"], additionalProperties: false,
  properties: { deliveryId: { type: "string" }, state: { enum: ["completed", "in_progress", "uncertain", "conflict"] }, duplicate: { type: "boolean" } } } as const;

const personaErrorSchema: ApiSchema = { type: "object", required: ["code", "message"], additionalProperties: true, properties: { code: { const: -1 }, message: { type: "string" }, status: { const: "failed" }, uncertain: { type: "boolean" }, messageId: { type: "string" }, replyContext: { type: "object" }, statusCode: { type: "integer" }, idempotency: idempotencySchema } };
const personaPath = { type: "object", required: ["personaId"], additionalProperties: false, properties: { personaId: { type: "string" } } } as const;
const queryAndHeaders = { type: "object" } as const;
/** Register public operations directly against the original persona and durable-delivery owners. */
export function createPersonaMessagingOperations(context: () => PersonaMessagingRouteContext): readonly ApiOperationDefinition[] {
  const errors = Object.fromEntries([400, 403, 404, 409, 413, 500, 502, 503].map(status => [String(status), { mediaType: "application/json", schema: personaErrorSchema }]));
  const selectedId = (input: ApiOperationInput) => { const id = sanitizeRoleId(input.path.personaId); if (!id) throw new PersonaMessagingError(400, "Invalid persona id."); return id; };
  const errorResult = (error: unknown, failed = false) => { if (error instanceof ApiContractError) throw error;
    const status = error instanceof PersonaMessagingError ? error.statusCode : error instanceof SyntaxError ? 400 : 500;
    return { status, body: errorResponsePresentation({ code: -1, ...(failed ? { status: "failed" } : {}), ...(failed && status === 500 ? { uncertain: true } : {}), message: error instanceof Error ? error.message : String(error) }, status) }; };
  const send = async (input: ApiOperationInput, owner: PersonaMessagingRouteContext) => {
    try { const personaId = selectedId(input);
      const assertAuthority = () => { try { hasAuthenticatedConnectionRequest(input.request); } catch { throw new ApiContractError(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization", "manager.personas.messages.send", true); } };
      return await executePersonaMessageRequest(personaId, input.body as PersonaMessageRequest, owner, input.signal, assertAuthority);
    } catch (error) { return errorResult(error, true); }
  };
  return [{ contract: { operationId: "manager.personas.read", aliases: ["agent:GET:/api/personas/:personaId"], contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/personas/:personaId", exposure: "public", transport: "http",
    description: "Read a persona through the original presentation and local Route directory.",
    request: { path: personaPath, query: queryAndHeaders, headers: queryAndHeaders, body: { kind: "none" } },
    responses: { ...errors, "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "persona"], additionalProperties: false, properties: { code: { const: 0 }, persona: personaSummarySchema } } } },
    effects: { mode: "read", description: "Read the current persona directory without delivering messages." }, recovery: { strategy: "repeatable-read", description: "Repeat the same persona read after native catalog recovery." },
    validators: [{ id: "persona-read-native-identity", description: "Retain the original persona ID sanitizer, active storage root, local-route projection and not-found result." }]
  }, handler: input => { try { return { status: 200, body: { code: 0, persona: resolvePersona(selectedId(input), listPersonas(context())) } }; } catch (error) { return errorResult(error); } } },
  { contract: { operationId: "manager.personas.messages.receipt", aliases: ["agent:GET:/api/personas/messages/receipts/:deliveryId"], contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/personas/messages/receipts/:deliveryId", exposure: "public", transport: "http",
    description: "Read the original persistent persona-message receipt without redispatch or repair writes.",
    request: { path: { type: "object", required: ["deliveryId"], additionalProperties: false, properties: { deliveryId: { type: "string" } } }, query: queryAndHeaders, headers: queryAndHeaders, body: { kind: "none" } },
    responses: { ...errors, "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "receipt"], additionalProperties: false, properties: { code: { const: 0 }, receipt: { type: "object", required: ["version", "deliveryId", "requestDigest", "state", "createdAt", "updatedAt"], additionalProperties: true, properties: { version: { const: 1 }, deliveryId: { type: "string" }, requestDigest: { type: "string" }, state: { enum: DURABLE_DELIVERY_RECEIPT_STATES }, createdAt: { type: "string" }, updatedAt: { type: "string" }, result: { type: "object", additionalProperties: true }, error: { type: "string" } } } } } } },
    effects: { mode: "read", description: "Read only the original persona-message-idempotency namespace." }, recovery: { strategy: "repeatable-read", description: "Retain deliveryId; completed is the ledger state, while result.status reports delivery success or failure. Missing, sending or uncertain records never authorize a new ID or an automatic resend." },
    validators: [{ id: "persona-receipt-native-identity", description: "The native delivery ID normalizer and receipt reader own validation and persistence. Unknown query fields remain ignored." }]
  }, handler: input => { try { const deliveryId = normalizeDurableDeliveryId(input.path.deliveryId), receipt = readDurableDeliveryReceipt<Record<string, unknown>>(context().rootDir, "persona-message-idempotency", deliveryId);
    return receipt ? { status: 200, body: { code: 0, receipt } } : { status: 404, body: errorResponsePresentation({ code: -1, message: "Persona message receipt was not found." }, 404) };
    } catch (error) { return { status: 400, body: errorResponsePresentation({ code: -1, message: error instanceof Error ? error.message : String(error) }, 400) }; } } },
  { contract: { operationId: "manager.personas.messages.send", aliases: ["agent:POST:/api/personas/:personaId/messages"], contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/personas/:personaId/messages", exposure: "public", transport: "http",
    description: "Deliver through the original persona source-proof and persistent delivery owner, preserving the stable deliveryId.",
    request: { path: personaPath, query: queryAndHeaders, headers: queryAndHeaders, body: { kind: "json", maxBytes: PERSONA_MESSAGE_LIMITS.requestBytes, allowAnyContentType: true, emptyValue: {}, schema: { type: "object", additionalProperties: true, properties: personaMessageRequestFields } } },
    responses: { ...errors, "202": { mediaType: "application/json", schema: { type: "object", required: ["code", "status", "sourcePersonaId", "sourceRouteId", "targetPersonaId", "targetRouteId", "conversationId", "hopCount", "timelineRecorded", "idempotency"], additionalProperties: false,
      properties: { code: { const: 0 }, status: { const: "delivered" }, sourcePersonaId: { type: "string" }, sourceRouteId: { type: "string" }, targetPersonaId: { type: "string" }, targetRouteId: { type: "string" }, conversationId: { type: "string" }, hopCount: { type: "integer", minimum: 0, maximum: PERSONA_MESSAGE_LIMITS.maxHops }, timelineRecorded: { type: "boolean" }, message: rolePanelMessageSchema, idempotency: idempotencySchema } } } },
    effects: { mode: "agent-delivery", description: "Reserve and settle the existing persistent receipt, deliver once through the original Desktop owner, and audit the captured target timeline." },
    recovery: { strategy: "stable-idempotency-receipt", receiptPath: "/api/personas/messages/receipts/:deliveryId", description: "Retain deliveryId and the normalized original payload. Matching completed requests reuse the original result; changed payloads conflict. Sending or uncertain outcomes require reading the original receipt, without replacement IDs or automatic retries. Audit failure never redispatches." },
    validators: [{ id: "persona-message-source-and-target", description: "The original source Route proof is request provenance, not a remote feature grant. Retain enabled local source, distinct target persona, enabled target selection, unique-route default and original text/reference/hop coercion and limits. Capture target identity and audit ownership before durable awaits. Recheck the existing enabled/local source and target object conditions immediately before actual dispatch." }]
  }, prepare: () => {
    // Capture the original storage/application owner before consuming a queued body.
    try { const owner = context(); return input => send(input, owner); } catch (error) { return errorResult(error); }
  }, handler: input => send(input, context()) }];
}

async function executePersonaMessageRequest(personaId: string, body: PersonaMessageRequest, context: PersonaMessagingRouteContext, signal: AbortSignal | undefined, assertAuthority: () => void) {
  let deliveryId: string;
  try { deliveryId = normalizeDurableDeliveryId(body.deliveryId); } catch (error) { throw new PersonaMessagingError(400, error instanceof Error ? error.message : String(error)); }
  const prepared = preparePersonaMessage(personaId, body, context);
  const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "persona-message-idempotency", deliveryId, requestAuthority: assertAuthority,
    payload: { sourceRouteId: prepared.sourceRouteId, targetPersonaId: prepared.targetPersonaId, targetRouteId: prepared.targetRouteId, conversationId: prepared.conversationId, inReplyToMessageId: prepared.inReplyToMessageId, hopCount: prepared.hopCount, text: prepared.text },
    deliver: async () => {
      signal?.throwIfAborted(); assertAuthority();
      try {
        if (!context.authorizeSource(prepared.sourceRouteId, prepared.sourcePersonaId, String(body.sourceCapability || "").trim())) throw new PersonaMessagingError(403, "The source Route capability is missing or invalid.");
        const source = enabledRuntime(prepared.sourceRouteId, context);
        const target = enabledRuntime(prepared.targetRouteId, context);
        if (source.definition.agentRoleDeviceId || personaIdForDefinition(source.definition) !== prepared.sourcePersonaId) throw new PersonaMessagingError(409, "The original source Route no longer belongs to this local persona.");
        if (target.definition.agentRoleDeviceId || personaIdForDefinition(target.definition) !== prepared.targetPersonaId) throw new PersonaMessagingError(409, "The original target Route no longer belongs to this local persona.");
        return await deliverPersonaMessage(prepared, context);
      }
      catch (error) { if (error instanceof PersonaMessagingError) return { status: "failed", statusCode: error.statusCode, message: error.message, ...error.delivery }; throw error; }
    }
  });
  if (outcome.state === "completed") { const failed = outcome.result.status === "failed"; const status = failed ? Number(outcome.result.statusCode || 502) : 202;
    return { status, body: errorResponsePresentation({ code: failed ? -1 : 0, ...outcome.result, idempotency: { deliveryId, state: "completed", duplicate: outcome.duplicate } }, status) }; }
  const status = outcome.state === "uncertain" ? 503 : 409;
  return { status, body: errorResponsePresentation({ code: -1, status: "failed", message: outcome.reason, idempotency: { deliveryId, state: outcome.state, duplicate: true } }, status) };
}

import { parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { agentStateReportDecision } from "../agentAdapters/stateReportOrder.js";
import { agentAdapterTypes } from "../shared/agentAdapterCapabilities.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { resolveReportedCodexBindingUpdate } from "./codexBindingUpdate.js";
import type { ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";

type BindingDefinition = { codexThreadId?: string; codexCwd?: string };
type ReportedState = Record<string, unknown> & { agentAdapterType: AgentAdapterType };
export type AgentStateReportOwnerOptions<D extends BindingDefinition> = Readonly<{
  runtime(gatewayId: string): { definition: D; agentStateGeneration?: string } | undefined;
  states: Map<string, Partial<Record<AgentAdapterType, ReportedState>>>;
  writeAdapterConfigFile(definition: D): Promise<void>;
  publishManagerEvent(type: "codex_binding_replaced", payload: Record<string, unknown>): void;
}>;

/** Owns the existing report-order, state merge and binding persistence transaction. No HTTP routing lives here. */
export function createAgentStateReportOwner<D extends BindingDefinition>(options: AgentStateReportOwnerOptions<D>) {
  return async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const gatewayId = sanitizeRoleId(body.gatewayId);
    const adapterType = parseAgentAdapterType(body.adapterType as string | undefined);
    const runtime = gatewayId ? options.runtime(gatewayId) : undefined;
    if (!gatewayId || !adapterType || !runtime) throw new Error("Invalid agent state report target.");
    const generation = typeof body.generation === "string" ? body.generation.trim() : "";
    const sequence = Number(body.sequence);
    const previous = options.states.get(gatewayId) ?? {};
    const reportDecision = agentStateReportDecision(runtime.agentStateGeneration, generation, sequence, previous[adapterType]?.reportSequence);
    if (reportDecision === "invalid-generation") throw new Error("Stale or invalid agent state report generation.");
    if (reportDecision === "out-of-order") return { status: 202, body: { code: 0, ignored: true } } as const;
    signal?.throwIfAborted();
    const state = (body.state ?? {}) as Record<string, unknown>;
    previous[adapterType] = { ...(previous[adapterType] ?? {}), ...state, agentAdapterType: adapterType,
      reportGeneration: generation, reportSequence: sequence, updatedAt: new Date().toISOString() };
    options.states.set(gatewayId, previous);
    // These effects deliberately retain the original runtime definition even while persistence awaits.
    try {
      if (adapterType === "codex") {
        const bindingUpdate = resolveReportedCodexBindingUpdate(runtime.definition, state);
        if (bindingUpdate) {
          runtime.definition.codexThreadId = bindingUpdate.threadId;
          runtime.definition.codexCwd = bindingUpdate.workspace;
          await options.writeAdapterConfigFile(runtime.definition);
          options.publishManagerEvent("codex_binding_replaced", { gatewayId,
            previousThreadId: String(state.bindingPreviousThreadId || ""), threadId: bindingUpdate.threadId, workspace: bindingUpdate.workspace });
        }
      }
    } catch (error) {
      // A report already changed native state; a failed persistence acknowledgement is not an unexecuted write.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { uncertain: true });
    }
    return { status: 200, body: { code: 0 } } as const;
  };
}

export function createAgentStateReportOperations(report: ReturnType<typeof createAgentStateReportOwner>): readonly ApiOperationDefinition[] {
  const handler = async (input: ApiOperationInput) => {
    try { return await report(input.body as Record<string, unknown>, input.signal); }
    catch (error) { return { status: 400, body: { code: -1, message: error instanceof Error ? error.message : String(error),
      ...((error as { uncertain?: boolean })?.uncertain ? { uncertain: true } : {}) } }; }
  };
  return [{ contract: {
    operationId: "manager.agent-state.report", aliases: ["agent:POST:/api/agent-state"], contractVersion: "1.0.0", method: "POST",
    pathTemplate: "/api/agent-state", exposure: "public", transport: "http",
    description: "Merge a native Agent business-state report for an existing gateway and process generation. A report does not run an Agent prompt.",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" },
      body: { kind: "json", maxBytes: 0, allowAnyContentType: true, schema: { type: "object", additionalProperties: true, properties: {
        gatewayId: { description: "Native sanitizeRoleId accepts trimmed Unicode letters, digits, underscores and hyphens after String coercion; the target gateway must exist." },
        adapterType: { type: "string", enum: agentAdapterTypes }, generation: { description: "Must be a string whose trimmed value equals the original gateway process generation." },
        sequence: { description: "Native Number coercion must yield a positive safe integer; only a sequence newer than the stored value is merged." },
        state: { description: "Native shallow merge of supplied state; reserved adapter, generation, sequence and updatedAt fields are overwritten by the owner." }
      } } } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { const: 0 } } } },
      "202": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "ignored"], properties: { code: { const: 0 }, ignored: { const: true } } } },
      "400": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" }, uncertain: { const: true } } } } },
    effects: { mode: "state-report", description: "Update the original gateway/adapter state map. Valid Codex binding replacements update the same runtime definition, await its existing config writer, then publish codex_binding_replaced." },
    recovery: { strategy: "generation-sequence-readback", receiptPath: "/api/gateways", description: "Retain gatewayId, adapterType, generation and sequence. Inspect that gateway's native agentStates before retrying an uncertain report. Same-generation duplicate/older sequences return 202 ignored; this is not confirmation that a failed binding write persisted." },
    validators: [{ id: "native-report-order", description: "The original process-generation and positive-safe-sequence validator rejects stale process reports. Out-of-order reports do not mutate state or bindings. No additional remote grant or persona binding is required." },
      { id: "native-codex-binding", description: "The existing Codex binding validator alone decides whether a report can replace its previous full task ID and workspace. This operation neither scans sessions nor creates or executes tasks." }]
  }, handler }];
}

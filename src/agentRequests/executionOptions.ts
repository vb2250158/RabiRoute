import { createHash } from "node:crypto";
import type { AgentThreadRequest, AgentThreadRequestOptions } from "../agentThreads.js";
import type { CodexDesktopReasoningEffort } from "../codexDesktopBridge.js";
import type { CodexTurnSandbox } from "../codexRuntime.js";

/** Immutable per-delivery snapshot; owner identity and live permissions are separate. */
export type EndpointExecutionOptions = {
  cwd?: string;
  model?: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
  /** Compatibility input only: Desktop retains its own sandbox and approval policy. */
  sandbox?: CodexTurnSandbox;
  dshDeliveryMode?: "queue" | "steer";
};

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid endpoint execution ${name}.`);
  }
  return value.trim();
}

/** Canonical ordering and strict fields prevent silent option drops at transport boundaries. */
export function normalizeEndpointExecutionOptions(value: unknown): EndpointExecutionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Endpoint execution options are required.");
  const input = value as Record<string, unknown>;
  const fields = ["cwd", "model", "reasoningEffort", "sandbox", "dshDeliveryMode"];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error("Unsupported endpoint execution option.");
  const result: EndpointExecutionOptions = input.cwd === undefined ? {} : { cwd: boundedText(input.cwd, "cwd", 32_768) };
  if (input.model !== undefined) result.model = boundedText(input.model, "model", 500);
  if (input.reasoningEffort !== undefined) {
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(input.reasoningEffort))) {
      throw new Error("Invalid endpoint execution reasoningEffort.");
    }
    result.reasoningEffort = input.reasoningEffort as CodexDesktopReasoningEffort;
  }
  if (input.sandbox !== undefined) {
    if (!["read-only", "workspace-write", "danger-full-access"].includes(String(input.sandbox))) throw new Error("Invalid endpoint execution sandbox.");
    result.sandbox = input.sandbox as CodexTurnSandbox;
  }
  if (input.dshDeliveryMode !== undefined) {
    if (input.dshDeliveryMode !== "queue" && input.dshDeliveryMode !== "steer") throw new Error("Invalid endpoint execution dshDeliveryMode.");
    result.dshDeliveryMode = input.dshDeliveryMode;
  }
  return result;
}

export function endpointExecutionOptionsHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeEndpointExecutionOptions(value))).digest("hex");
}

export function resolveEndpointExecutionOptions(request: AgentThreadRequest, ownerWorkspace: string | undefined,
  defaults: AgentThreadRequestOptions["codexDefaults"]): EndpointExecutionOptions {
  if (request.agentAdapter === "deviceAgent") {
    if (request.cwd !== undefined || request.model !== undefined || request.reasoningEffort !== undefined || request.sandbox !== undefined || request.dshDeliveryMode !== undefined) {
      throw new Error("Device endpoint uses its own runtime and cannot apply PC execution options.");
    }
    return {};
  }
  const explicitModel = request.model !== undefined;
  const model = explicitModel ? request.model : request.agentAdapter === "codex" ? defaults?.model : undefined;
  const reasoningEffort = request.reasoningEffort ?? (!explicitModel && request.agentAdapter === "codex" ? defaults?.reasoningEffort : undefined);
  const options = normalizeEndpointExecutionOptions({ cwd: request.cwd ?? ownerWorkspace,
    ...(model !== undefined ? { model } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(request.sandbox !== undefined ? { sandbox: request.sandbox } : {}),
    ...(request.dshDeliveryMode !== undefined ? { dshDeliveryMode: request.dshDeliveryMode } : {}) });
  if (!options.cwd) throw new Error("This PC endpoint requires its actual owner execution directory.");
  if (request.agentAdapter !== "codex" && (options.model !== undefined || options.reasoningEffort !== undefined || options.sandbox !== undefined)) {
    throw new Error("This endpoint provider cannot apply model, reasoningEffort or sandbox through the prepared delivery contract.");
  }
  if (options.reasoningEffort && !options.model) throw new Error("Reasoning effort requires an explicit or target Route model; owner settings were not changed.");
  if (request.agentAdapter !== "dsh" && options.dshDeliveryMode !== undefined) throw new Error("dshDeliveryMode is only supported by DSH.");
  return options;
}

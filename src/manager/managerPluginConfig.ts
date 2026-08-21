import { createHash } from "node:crypto";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import type { DesiredManagerPlugin } from "../runtime/managerPluginReconciler.js";
import { builtinManagerPluginDefinitions } from "./builtinManagerPlugins.js";
import type { ManagerConfig } from "./configRepository.js";

export type { DesiredManagerPlugin } from "../runtime/managerPluginReconciler.js";

export type ManagerPluginConfigDiagnostic = {
  code: "unknown_plugin" | "required_plugin_cannot_disable" | "unsupported_plugin_config";
  instanceId: string;
  message: string;
};

export type NormalizedManagerPluginConfig = {
  desired: DesiredManagerPlugin[];
  diagnostics: ManagerPluginConfigDiagnostic[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item !== "function" && item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}

function desiredRevision(definition: ManagerPluginDefinition, enabled: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({
      instanceId: definition.instanceId,
      manifest: definition.manifest,
      scope: definition.scope ?? "global",
      provides: definition.provides ?? [],
      requires: definition.requires ?? [],
      optional: definition.optional ?? [],
      missingCapabilities: definition.missingCapabilities ?? [],
      contributions: definition.contributions ?? [],
      enabled
    })))
    .digest("hex");
}

export function normalizeManagerPluginConfig(
  config: Pick<ManagerConfig, "managerPlugins"> | undefined,
  definitions: readonly ManagerPluginDefinition[] = builtinManagerPluginDefinitions()
): NormalizedManagerPluginConfig {
  const allowedInstanceIds = new Set(definitions.map(definition => definition.instanceId));
  const configuredEnabled = new Map<string, boolean>();
  const diagnostics: ManagerPluginConfigDiagnostic[] = [];

  for (const [instanceId, entry] of Object.entries(config?.managerPlugins ?? {}).sort(([left], [right]) => compareText(left, right))) {
    if (!allowedInstanceIds.has(instanceId)) {
      diagnostics.push({
        code: "unknown_plugin",
        instanceId,
        message: `Unknown Manager plugin instance: ${instanceId}`
      });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({
        code: "unsupported_plugin_config",
        instanceId,
        message: `Manager plugin config must contain only an optional boolean enabled field: ${instanceId}`
      });
      continue;
    }

    const rawEntry = entry as Record<string, unknown>;
    const unsupportedFields = Object.keys(rawEntry)
      .filter(field => field !== "enabled" || (
        rawEntry.enabled !== undefined && typeof rawEntry.enabled !== "boolean"
      ))
      .sort(compareText);
    if (unsupportedFields.length) {
      diagnostics.push({
        code: "unsupported_plugin_config",
        instanceId,
        message: `Unsupported Manager plugin config fields for ${instanceId}: ${unsupportedFields.join(", ")}`
      });
    }
    if (typeof rawEntry.enabled === "boolean") {
      configuredEnabled.set(instanceId, rawEntry.enabled);
    }
  }

  const desired = definitions.map(definition => {
    const requestedEnabled = configuredEnabled.get(definition.instanceId);
    const required = definition.instanceId === "manager:core";
    if (required && requestedEnabled === false) {
      diagnostics.push({
        code: "required_plugin_cannot_disable",
        instanceId: definition.instanceId,
        message: `Required Manager plugin cannot be disabled: ${definition.instanceId}`
      });
    }
    const enabled = required || requestedEnabled !== false;
    return {
      definition,
      enabled,
      revision: desiredRevision(definition, enabled)
    };
  });

  return { desired, diagnostics };
}

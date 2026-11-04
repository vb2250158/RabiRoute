import fs from "node:fs/promises";
import path from "node:path";
import type { PluginPackageCatalog, PluginProfile } from "../plugin-kernel/profile.js";
import type { PluginManifest } from "../plugin-kernel/types.js";
import { gatewayEndpointTypesFromManifests } from "../shared/messageEndpointTypes.js";
import { resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";
import { gatewayRouteSnapshotRevision as routeSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";
export { gatewayRouteSnapshotRevision as routeSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";

export type EndpointRouteConfigDeclaration = Readonly<{
  endpointType: string;
  /** Explicit native service mapping for non-message adapter owners. */
  capability?: string;
  agentType?: string;
  environmentFields?: Readonly<Record<string, string>>;
  /** A shared worker's source binding remains in its real dependency closure. */
  sharedBindingKeys?: readonly string[];
  sharedWhenEnabledPaths?: readonly (readonly string[])[];
  routeKeys: readonly string[];
  runtimeFields: Readonly<Record<string, Readonly<{ paths: readonly string[]; default?: unknown; defaultFrom?: "cwd" | "stateRoot"; trim?: boolean; emptyDefault?: boolean; format?: "number" | "positive-number" | "boolean" | "workspace" }>>>;
}>;

function parseDeclaration(value: unknown, manifest: PluginManifest): EndpointRouteConfigDeclaration {
  const raw = value as EndpointRouteConfigDeclaration | undefined;
  if (!raw || typeof raw.endpointType !== "string"
    || !(raw.agentType ? typeof raw.agentType === "string" && manifest.entries.gateway && typeof raw.capability === "string" && manifest.provides.includes(raw.capability)
      && raw.endpointType === `agent:${raw.agentType}` : gatewayEndpointTypesFromManifests([manifest]).has(raw.endpointType))
    || !Array.isArray(raw.routeKeys) || raw.routeKeys.some(key => typeof key !== "string" || !key)
    || !raw.runtimeFields || typeof raw.runtimeFields !== "object" || Object.values(raw.runtimeFields).some(field => !field || !Array.isArray(field.paths) || field.paths.some(key => typeof key !== "string"))) {
    throw new Error(`Invalid endpoint-owned Route projection: ${manifest.id}`);
  }
  if (raw.routeKeys.some(key => !Object.values(raw.runtimeFields).some(field => field.paths.includes(key)))) throw new Error(`Endpoint-owned Route key has no runtime projection: ${manifest.id}`);
  if (raw.environmentFields && Object.entries(raw.environmentFields).some(([key, field]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || !raw.runtimeFields[field])) throw new Error(`Invalid adapter environment projection: ${manifest.id}`);
  if (raw.sharedBindingKeys && (!Array.isArray(raw.sharedBindingKeys) || raw.sharedBindingKeys.some(key => typeof key !== "string" || !raw.routeKeys.includes(key)))) throw new Error(`Invalid adapter shared binding projection: ${manifest.id}`);
  if (raw.sharedWhenEnabledPaths && (!Array.isArray(raw.sharedWhenEnabledPaths) || raw.sharedWhenEnabledPaths.some(keys => !Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== "string" || !key)))) throw new Error(`Invalid adapter shared dependency: ${manifest.id}`);
  return raw;
}

export function routeDeclarationCapability(declaration: EndpointRouteConfigDeclaration): string {
  return declaration.capability ?? `endpoint.${declaration.endpointType}@1`;
}

function parseDeclarationJson(text: string, manifest: PluginManifest): EndpointRouteConfigDeclaration {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("Invalid endpoint Route declaration JSON."); throw error; }
  return parseDeclaration(value, manifest);
}

/** An active owner keeps its exact immutable contract over newer installed bytes. */
export function mergeEndpointRouteDeclarations(active: readonly EndpointRouteConfigDeclaration[], installed: readonly EndpointRouteConfigDeclaration[]): EndpointRouteConfigDeclaration[] {
  const declarations = new Map(installed.map(value => [value.endpointType, value]));
  for (const declaration of active) declarations.set(declaration.endpointType, declaration);
  return [...declarations.values()];
}

/** Metadata only: disabled or failed packages never need executable preparation to retain field ownership. */
export async function readInstalledEndpointRouteDeclarations(profile: PluginProfile, catalog: Pick<PluginPackageCatalog, "resolve">,
  readManifest: (packageId: string, version: string) => Promise<PluginManifest>): Promise<{
    declarations: EndpointRouteConfigDeclaration[]; diagnostics: Array<{instanceId: string; message: string}>;
  }> {
  const results = await Promise.all(profile.instances.map(async instance => {
    try {
      const manifest = await readManifest(instance.package, instance.version);
      const source = await catalog.resolve(instance.package, instance.version);
      let text: string;
      try { text = await fs.readFile(path.join(source.sourceRoot, "route-config.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const declaration = parseDeclarationJson(text, manifest);
      return {declaration};
    } catch (error) {
      return {diagnostic: {instanceId: instance.id, message: error instanceof Error ? error.message : String(error)}};
    }
  }));
  return {declarations: results.flatMap(result => result?.declaration ? [result.declaration] : []),
    diagnostics: results.flatMap(result => result?.diagnostic ? [result.diagnostic] : [])};
}

export function sharedRouteProjection(definition: object, declarations: readonly EndpointRouteConfigDeclaration[]): Readonly<Record<string, unknown>> {
  const owned = new Set(declarations.flatMap(declaration => [...declaration.routeKeys]));
  return Object.fromEntries(Object.entries(definition).filter(([key]) => !owned.has(key)));
}

export function endpointRouteProjection(definition: object, declaration: EndpointRouteConfigDeclaration): Readonly<Record<string, unknown>> {
  const values = definition as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.entries(declaration.runtimeFields).map(([field, mapping]) => {
    let value: unknown = mapping.paths.map(key => values[key]).find(item => item !== undefined && item !== null);
    if (value === undefined) value = mapping.default;
    if (mapping.trim && typeof value === "string") value = value.trim();
    if (mapping.emptyDefault && value === "") value = mapping.default;
    if ((value === undefined || value === "") && mapping.defaultFrom) value = mapping.defaultFrom === "cwd" ? process.cwd() : process.env.RABIROUTE_STATE_ROOT || process.cwd();
    if (mapping.format === "workspace" && typeof value === "string" && value) value = path.resolve(process.env.RABIROUTE_STATE_ROOT || process.cwd(), value);
    if (mapping.format === "number") value = Number(value);
    if (mapping.format === "positive-number") { const number = Number(value); value = Number.isFinite(number) && number > 0 ? number : mapping.default; }
    if (mapping.format === "boolean") value = typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
    return [field, structuredClone(value)];
  }));
}

export function endpointRouteInputs(definition: object, declaration: EndpointRouteConfigDeclaration): Readonly<Record<string, unknown>> {
  const values = definition as Readonly<Record<string, unknown>>;
  return Object.fromEntries(declaration.routeKeys.filter(key => values[key] !== undefined).map(key => [key, structuredClone(values[key])]));
}

export function inheritedEndpointFields(boot: object, next: object, declaration: EndpointRouteConfigDeclaration): string[] {
  const prior = boot as Readonly<Record<string, unknown>>, after = next as Readonly<Record<string, unknown>>;
  return Object.entries(declaration.runtimeFields).filter(([, field]) =>
    routeSnapshotRevision(Object.fromEntries(field.paths.map(key => [key, prior[key]]))) === routeSnapshotRevision(Object.fromEntries(field.paths.map(key => [key, after[key]])))
  ).map(([key]) => key);
}

export function classifyRouteChange(previous: object, next: object, declarations: readonly EndpointRouteConfigDeclaration[]) {
  const endpointTypes = declarations.filter(declaration =>
    routeSnapshotRevision({ config: endpointRouteProjection(previous, declaration), inputs: endpointRouteInputs(previous, declaration) }) !== routeSnapshotRevision({ config: endpointRouteProjection(next, declaration), inputs: endpointRouteInputs(next, declaration) })
  ).map(declaration => declaration.endpointType);
  const bindingDependencyChanged = declarations.some(declaration => {
    if (!declaration.agentType || !declaration.sharedBindingKeys?.length) return false;
    const readPath = (definition: object, keys: readonly string[]): unknown => keys.reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, definition);
    const usesSharedBinding = (definition: object) => {
      const target = resolvePrimaryAgentTarget(definition);
      return Boolean(target && target.provider === declaration.agentType && !target.binding
        && declaration.sharedWhenEnabledPaths?.some(keys => readPath(definition, keys) === true));
    };
    return (usesSharedBinding(previous) || usesSharedBinding(next))
      && declaration.sharedBindingKeys.some(key => routeSnapshotRevision(readPath(previous, [key])) !== routeSnapshotRevision(readPath(next, [key])));
  });
  const sharedChanged = bindingDependencyChanged || routeSnapshotRevision(sharedRouteProjection(previous, declarations)) !== routeSnapshotRevision(sharedRouteProjection(next, declarations));
  return { kind: sharedChanged ? "shared" as const : endpointTypes.length ? "endpoint" as const : "none" as const, sharedChanged, endpointTypes };
}

/** Metadata comes from the exact immutable bytes selected by the native package owner. */
export async function readEndpointRouteDeclarations(packages: readonly Readonly<{instance: Readonly<{id: string}>; package: Readonly<{runtimeRoot: string; manifest: PluginManifest}>}>[]): Promise<{
  declarations: EndpointRouteConfigDeclaration[]; diagnostics: Array<{ instanceId: string; message: string }>;
}> {
  const result: EndpointRouteConfigDeclaration[] = [];
  const diagnostics: Array<{ instanceId: string; message: string }> = [];
  for (const item of packages) {
    try {
      const text = await fs.readFile(path.join(item.package.runtimeRoot, "route-config.json"), "utf8");
      result.push(parseDeclarationJson(text, item.package.manifest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      diagnostics.push({ instanceId: item.instance.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { declarations: result, diagnostics };
}

import fs from "node:fs/promises";
import path from "node:path";
import type { PluginPackageCatalog, PluginProfile } from "../plugin-kernel/profile.js";
import type { PluginManifest } from "../plugin-kernel/types.js";
import { gatewayEndpointTypesFromManifests } from "../shared/messageEndpointTypes.js";
import { gatewayRouteSnapshotRevision as routeSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";
export { gatewayRouteSnapshotRevision as routeSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";

export type EndpointRouteConfigDeclaration = Readonly<{
  endpointType: string;
  routeKeys: readonly string[];
  runtimeFields: Readonly<Record<string, Readonly<{ paths: readonly string[]; default?: unknown; trim?: boolean; emptyDefault?: boolean; format?: "number" | "positive-number" | "boolean" }>>>;
}>;

function parseDeclaration(value: unknown, manifest: PluginManifest): EndpointRouteConfigDeclaration {
  const raw = value as EndpointRouteConfigDeclaration | undefined;
  if (!raw || typeof raw.endpointType !== "string" || !gatewayEndpointTypesFromManifests([manifest]).has(raw.endpointType)
    || !Array.isArray(raw.routeKeys) || raw.routeKeys.some(key => typeof key !== "string" || !key)
    || !raw.runtimeFields || typeof raw.runtimeFields !== "object" || Object.values(raw.runtimeFields).some(field => !field || !Array.isArray(field.paths) || field.paths.some(key => typeof key !== "string"))) {
    throw new Error(`Invalid endpoint-owned Route projection: ${manifest.id}`);
  }
  if (raw.routeKeys.some(key => !Object.values(raw.runtimeFields).some(field => field.paths.includes(key)))) throw new Error(`Endpoint-owned Route key has no runtime projection: ${manifest.id}`);
  return raw;
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
  const sharedChanged = routeSnapshotRevision(sharedRouteProjection(previous, declarations)) !== routeSnapshotRevision(sharedRouteProjection(next, declarations));
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

import { h, type Component } from "vue";
import { webReleaseQuery } from "./webRelease";
import {
  beginTrustedWebPageReplacement,
  activeTrustedWebPage,
  mountedTrustedWebPages,
  onActiveTrustedWebPageChanged,
  registerTrustedWebPage,
  type TrustedWebPageRegistration
} from "./pluginPages";
import {
  registerTrustedWebThemeResource,
  type TrustedWebThemeResourceRegistration
} from "./pluginThemes";
import {
  registerTrustedWebSettingsRenderer,
  registerTrustedWebStatusRenderer,
  type TrustedWebSettingsRendererRegistration,
  type TrustedWebStatusRendererRegistration
} from "./pluginRenderers";
import { registerTrustedWebCommand, type TrustedWebCommandRegistration } from "./pluginCommands";

type WebPluginModuleInstanceDescriptor = Readonly<{
  instanceId: string;
}>;

type WebPluginModuleDescriptor = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  instances: readonly WebPluginModuleInstanceDescriptor[];
}>;

type WebPluginInstanceRegistrationApi = Readonly<{
  instanceId: string;
  pluginId: string;
  version: string;
  h: typeof h;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  registerCommand(input: Omit<TrustedWebCommandRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

type WebPluginModuleRegistrationApi = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  instanceIds: readonly string[];
  h: typeof h;
  forInstance(instanceId: string): WebPluginInstanceRegistrationApi;
}>;

type WebPluginModule = Readonly<{
  activate?: (api: WebPluginModuleRegistrationApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;

type ActiveModule = Readonly<{ descriptor: WebPluginModuleDescriptor; dispose: () => void | Promise<void> }>;

const active = new Map<string, ActiveModule>();
let syncQueue: Promise<void> = Promise.resolve();
let deferredReplacement = false;
let deferredRefreshFlight: Promise<void> | undefined;
let disposing = false;

export function retainActiveWebPluginModule(
  loaded: WebPluginModuleDescriptor,
  target: WebPluginModuleDescriptor | undefined,
  page: TrustedWebPageRegistration | undefined = activeTrustedWebPage()
): boolean {
  // Revocation still removes the capability. Only a compatible continuing owner is retained.
  return [page, ...mountedTrustedWebPages()].some(owner => !!target && !!owner && loaded.pluginId === owner.pluginId
    && loaded.instances.some(instance => instance.instanceId === owner.instanceId)
    && loaded.instances.every(instance => target.instances.some(next => next.instanceId === instance.instanceId))
    && target.pluginId === owner.pluginId
    && target.instances.some(instance => instance.instanceId === owner.instanceId));
}

onActiveTrustedWebPageChanged(() => {
  if (!deferredReplacement || deferredRefreshFlight || disposing) return;
  // Re-read the current catalog; an earlier queued descriptor may already be superseded.
  deferredRefreshFlight = refreshWebPluginModules()
    .catch(error => console.warn('Deferred Web plugin refresh failed; unrelated modules remain available.', error))
    .finally(() => { deferredRefreshFlight = undefined; });
});

function validInstance(value: unknown): value is WebPluginModuleInstanceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const instanceId = (value as Record<string, unknown>).instanceId;
  return typeof instanceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(instanceId);
}

function validDescriptor(value: unknown): value is WebPluginModuleDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!(["id", "pluginId", "version", "rev", "entryPath"].every(key => typeof record[key] === "string")
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(record.id as string)
    && /^[a-f0-9]{64}$/.test(record.rev as string)
    && /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(record.entryPath as string)
    && Array.isArray(record.instances)
    && record.instances.length > 0
    && record.instances.every(validInstance))) return false;
  return new Set(record.instances.map(item => (item as WebPluginModuleInstanceDescriptor).instanceId)).size === record.instances.length;
}

/** Instance membership changes require a full Bundle disposer/activation even when its revision is unchanged. */
export function sameWebPluginModuleInstances(
  left: readonly WebPluginModuleInstanceDescriptor[],
  right: readonly WebPluginModuleInstanceDescriptor[]
): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left.map(instance => instance.instanceId));
  return leftIds.size === right.length && right.every(instance => leftIds.has(instance.instanceId));
}

async function list(): Promise<{ modules: readonly WebPluginModuleDescriptor[]; invalidIds: ReadonlySet<string>; unidentified: boolean; failures: unknown[] }> {
  const response = await fetch(`/api/plugins/modules${webReleaseQuery()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load Web plugin modules: ${response.status}.`);
  const body = await response.json() as { code?: unknown; data?: { modules?: unknown } };
  if (body.code !== 0 || !Array.isArray(body.data?.modules)) {
    throw new Error("Web plugin module catalog is invalid.");
  }
  const modules = new Map<string, WebPluginModuleDescriptor>();
  const invalidIds = new Set<string>();
  const failures: unknown[] = [];
  let unidentified = false;
  for (const candidate of body.data.modules) {
    const id = candidate && typeof candidate === 'object' && typeof candidate.id === 'string' ? candidate.id : undefined;
    if (!validDescriptor(candidate) || !id || modules.has(id) || invalidIds.has(id)) {
      if (id) { invalidIds.add(id); modules.delete(id); } else unidentified = true;
      failures.push(new Error(`Invalid or ambiguous Web plugin module descriptor: ${id ?? 'unknown identity'}.`));
      continue;
    }
    modules.set(id, candidate);
  }
  return { modules: [...modules.values()].sort((left, right) => left.id.localeCompare(right.id)), invalidIds, unidentified, failures };

}

function instanceRegistrationApi(
  descriptor: WebPluginModuleDescriptor,
  instanceId: string,
  track: (cleanup: () => void) => () => void
): WebPluginInstanceRegistrationApi {
  const owner = { instanceId, pluginId: descriptor.pluginId };
  return Object.freeze({
    ...owner,
    version: descriptor.version,
    h,
    registerPage: input => track(registerTrustedWebPage({ ...input, ...owner })),
    registerSettingsRenderer: input => track(registerTrustedWebSettingsRenderer({ ...input, ...owner })),
    registerStatusRenderer: input => track(registerTrustedWebStatusRenderer({ ...input, ...owner })),
    registerTheme: input => track(registerTrustedWebThemeResource({ ...input, ...owner })),
    registerCommand: input => track(registerTrustedWebCommand({ ...input, ...owner })),
    asComponent: value => value
  });
}

function registrationApi(descriptor: WebPluginModuleDescriptor, track: (cleanup: () => void) => () => void): WebPluginModuleRegistrationApi {
  const instances = new Map(descriptor.instances.map(instance => [
    instance.instanceId,
    instanceRegistrationApi(descriptor, instance.instanceId, track)
  ]));
  const instanceIds = Object.freeze([...instances.keys()]);
  return Object.freeze({
    id: descriptor.id,
    pluginId: descriptor.pluginId,
    version: descriptor.version,
    instanceIds,
    h,
    forInstance(instanceId: string): WebPluginInstanceRegistrationApi {
      const api = instances.get(instanceId);
      if (!api) throw new Error(`Web Bundle does not own Manager instance: ${instanceId}.`);
      return api;
    }
  });
}

async function importModule(descriptor: WebPluginModuleDescriptor): Promise<WebPluginModule> {
  const url = `/api/plugins/modules/${encodeURIComponent(descriptor.id)}/${descriptor.rev}/${descriptor.entryPath.split("/").map(encodeURIComponent).join("/")}`;
  return await import(/* @vite-ignore */ url) as WebPluginModule;
}

async function activate(descriptor: WebPluginModuleDescriptor): Promise<ActiveModule> {
  const module = await importModule(descriptor);
  if (typeof module.activate !== "function") throw new Error(`Web plugin module does not export activate(): ${descriptor.id}.`);
  const registrations = new Set<() => void>();
  const track = (cleanup: () => void) => {
    let live = true;
    const release = () => { if (!live) return; live = false; registrations.delete(release); cleanup(); };
    registrations.add(release); return release;
  };
  const releaseRegistrations = () => {
    const failures: unknown[] = [];
    for (const release of [...registrations].reverse()) { try { release(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Web module registration cleanup failed.');
  };
  let cleanup: void | (() => void | Promise<void>);
  try { cleanup = await module.activate(registrationApi(descriptor, track)); }
  catch (error) {
    try { releaseRegistrations(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Web module activation and cleanup failed.'); }
    throw error;
  }
  return Object.freeze({ descriptor, dispose: async () => {
    try { await cleanup?.(); } finally { releaseRegistrations(); }
  } });

}

async function dispose(module: ActiveModule): Promise<void> {
  await module.dispose();
}

async function syncNow(): Promise<void> {
  const catalog = await list();
  const desired = catalog.modules;
  const desiredById = new Map(desired.map(item => [item.id, item]));
  const failures: unknown[] = [...catalog.failures];
  const attempted = new Set<string>();
  deferredReplacement = false;
  for (const [id, loaded] of [...active]) {
    const target = desiredById.get(id);
    if (catalog.invalidIds.has(id) || (!target && catalog.unidentified)) continue;
    if (target
      && target.rev === loaded.descriptor.rev
      && sameWebPluginModuleInstances(target.instances, loaded.descriptor.instances)) continue;
    if (retainActiveWebPluginModule(loaded.descriptor, target)) { deferredReplacement = true; continue; }
    attempted.add(id);
    const endReplacement = beginTrustedWebPageReplacement();
    try {
      await dispose(loaded);
      active.delete(id);
      if (!target) continue;
      try {
        active.set(id, await activate(target));
      } catch (error) {
        try {
          active.set(id, await activate(loaded.descriptor));
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Web plugin module update and rollback failed: ${id}.`);
        }
        throw error;
      }
    } catch (error) {
      failures.push(error);
    } finally {
      endReplacement();
    }
  }
  for (const descriptor of desired) {
    if (active.has(descriptor.id) || attempted.has(descriptor.id)) continue;
    try { active.set(descriptor.id, await activate(descriptor)); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Some Web plugin modules could not be refreshed.");
}

export function refreshWebPluginModules(): Promise<void> {
  const next = syncQueue.then(syncNow);
  syncQueue = next.catch(() => {});
  return next;
}

export async function disposeWebPluginModules(): Promise<void> {
  disposing = true;
  await syncQueue;
  for (const module of [...active.values()].reverse()) await dispose(module);
  active.clear();
  deferredReplacement = false;
  disposing = false;
}

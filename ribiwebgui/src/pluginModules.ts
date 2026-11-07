import { h, ref, type Component } from "vue";
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
import { registerPluginTranslations, type PluginTranslationCatalogs } from "./i18n/translationRegistry";

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
  registerTranslations(catalogs: PluginTranslationCatalogs): () => void;
}>;

type WebPluginModule = Readonly<{
  activate?: (api: WebPluginModuleRegistrationApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;

type ModuleOwner = {
  descriptor: WebPluginModuleDescriptor;
  lifetime: AbortController;
  registrations: Set<() => void>;
  startup: Promise<void>;
  ready: boolean;
  cleanup?: () => void | Promise<void>;
  cleanupDone: boolean;
  earlyCleanupErrors?: unknown[];
  closing?: Promise<void>;
};
type ModuleSlot = {
  desired?: WebPluginModuleDescriptor;
  owner?: ModuleOwner;
  confirmed?: WebPluginModuleDescriptor;
  intent: number;
  processed: number;
  work?: Promise<void>;
  failure?: Readonly<{ error: unknown }>;
};
const modules = new Map<string, ModuleSlot>();
const moduleActivity = ref(0);
let syncQueue: Promise<void> = Promise.resolve();
let deferredReplacement = false;
let deferredRefreshFlight: Promise<void> | undefined;
let disposing = false;
let metadataEpoch = 0;
let catalogRead: AbortController | undefined;

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
  deferredRefreshFlight = refreshWebPluginModules({ initialization: "background" })
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

async function list(signal?: AbortSignal): Promise<{ modules: readonly WebPluginModuleDescriptor[]; invalidIds: ReadonlySet<string>; unidentified: boolean; failures: unknown[] }> {
  const response = await fetch(`/api/plugins/modules${webReleaseQuery()}`, { cache: "no-store", signal });
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
  track: (start: () => () => void) => () => void
): WebPluginInstanceRegistrationApi {
  const owner = { instanceId, pluginId: descriptor.pluginId };
  return Object.freeze({
    ...owner,
    version: descriptor.version,
    h,
    registerPage: input => track(() => registerTrustedWebPage({ ...input, ...owner })),
    registerSettingsRenderer: input => track(() => registerTrustedWebSettingsRenderer({ ...input, ...owner })),
    registerStatusRenderer: input => track(() => registerTrustedWebStatusRenderer({ ...input, ...owner })),
    registerTheme: input => track(() => registerTrustedWebThemeResource({ ...input, ...owner })),
    registerCommand: input => track(() => registerTrustedWebCommand({ ...input, ...owner })),
    asComponent: value => value
  });
}

function registrationApi(descriptor: WebPluginModuleDescriptor, track: (start: () => () => void) => () => void): WebPluginModuleRegistrationApi {
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
    registerTranslations: (catalogs: PluginTranslationCatalogs) => track(() => registerPluginTranslations(descriptor.pluginId, catalogs)),
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

function releaseRegistrations(owner: ModuleOwner): unknown[] {
  const failures: unknown[] = [];
  const endReplacement = beginTrustedWebPageReplacement();
  try {
    for (const release of [...owner.registrations].reverse()) {
      try { release(); } catch (error) { failures.push(error); }
    }
  } finally { endReplacement(); }
  return failures;
}

function cancelOwner(owner: ModuleOwner): void {
  if (owner.lifetime.signal.aborted) return;
  owner.lifetime.abort(new Error(`Web plugin module retired: ${owner.descriptor.id}.`));
  // Revoke host registrations now; the original activation/cleanup still owns
  // every late resource and remains joined below. No timeout implies release.
  owner.earlyCleanupErrors = releaseRegistrations(owner);
  moduleActivity.value++;
}

function createOwner(descriptor: WebPluginModuleDescriptor): ModuleOwner {
  const owner: ModuleOwner = { descriptor, lifetime: new AbortController(), registrations: new Set(),
    startup: Promise.resolve(), ready: false, cleanupDone: false };
  const track = (start: () => () => void) => {
    if (owner.lifetime.signal.aborted) return () => {};
    const cleanup = start();
    if (owner.lifetime.signal.aborted) { cleanup(); return () => {}; }
    let live = true;
    const release = () => {
      if (!live) return;
      cleanup(); live = false; owner.registrations.delete(release);
    };
    owner.registrations.add(release); return release;
  };
  owner.startup = (async () => {
    const module = await importModule(descriptor);
    owner.lifetime.signal.throwIfAborted();
    if (typeof module.activate !== "function") throw new Error(`Web plugin module does not export activate(): ${descriptor.id}.`);
    const cleanup = await module.activate(registrationApi(descriptor, track));
    if (typeof cleanup === "function") owner.cleanup = cleanup;
    owner.lifetime.signal.throwIfAborted();
    owner.ready = true; moduleActivity.value++;
  })();
  return owner;
}

function stopOwner(owner: ModuleOwner): Promise<void> {
  if (owner.closing) return owner.closing;
  cancelOwner(owner);
  const early = owner.earlyCleanupErrors ?? [];
  owner.earlyCleanupErrors = undefined;
  const closing = (async () => {
    // Activation failure is an execution result, not failed retirement. It can
    // still return late cleanup after cancellation, which this same owner joins.
    await owner.startup.catch(() => {});
    const failures = [...early];
    if (owner.cleanup && !owner.cleanupDone) {
      try { await owner.cleanup(); owner.cleanupDone = true; } catch (error) { failures.push(error); }
    }
    if (!early.length) failures.push(...releaseRegistrations(owner));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Web module retirement failed.');
  })();
  owner.closing = closing;
  void closing.catch(() => { if (owner.closing === closing) owner.closing = undefined; });
  return closing;
}

function sameDescriptor(left: WebPluginModuleDescriptor, right: WebPluginModuleDescriptor): boolean {
  return left.rev === right.rev && sameWebPluginModuleInstances(left.instances, right.instances);
}

async function driveModule(slot: ModuleSlot): Promise<void> {
  for (;;) {
    const intent = slot.intent, target = slot.desired;
    try {
      let owner = slot.owner;
      if (owner && (!target || !sameDescriptor(owner.descriptor, target) || owner.lifetime.signal.aborted)) {
        await stopOwner(owner);
        if (slot.owner === owner) slot.owner = undefined;
        owner = undefined;
      }
      if (intent !== slot.intent) continue;
      if (!target) { slot.processed = intent; return; }
      if (!owner) { owner = createOwner(target); slot.owner = owner; moduleActivity.value++; }
      try {
        await owner.startup;
        if (intent !== slot.intent || owner.lifetime.signal.aborted) continue;
        slot.confirmed = owner.descriptor; slot.processed = intent; return;
      } catch (error) {
        if (intent !== slot.intent || owner.lifetime.signal.aborted) {
          await stopOwner(owner); if (slot.owner === owner) slot.owner = undefined; continue;
        }
        slot.failure = { error }; moduleActivity.value++;
        try { await stopOwner(owner); } catch (cleanupError) {
          slot.processed = intent;
          throw new AggregateError([error, cleanupError], `Web plugin module activation and retirement failed: ${target.id}.`);
        }
        if (slot.owner === owner) slot.owner = undefined;
        if (intent !== slot.intent) continue;
        const previous = slot.confirmed;
        if (previous) {
          // Rollback never restores an instance revoked by the current catalog.
          const instances = previous.instances.filter(instance => target.instances.some(next => next.instanceId === instance.instanceId));
          if (instances.length) {
            const restored = createOwner({ ...previous, instances }); slot.owner = restored;
            try { await restored.startup; }
            catch (restoreError) {
              try { await stopOwner(restored); if (slot.owner === restored) slot.owner = undefined; }
              catch (cleanupError) { throw new AggregateError([error, restoreError, cleanupError], `Web plugin module update and rollback failed: ${target.id}.`); }
              throw new AggregateError([error, restoreError], `Web plugin module update and rollback failed: ${target.id}.`);
            }
          }
        }
        slot.processed = intent; throw error;
      }
    } catch (error) { slot.processed = intent; throw error; }
  }
}

function startModuleWork(id: string, slot: ModuleSlot): Promise<void> {
  if (slot.work) return slot.work;
  const work = driveModule(slot); slot.work = work;
  const finished = (failed: boolean, error?: unknown) => {
    if (failed) {
      slot.failure = { error };
      console.warn(`Web plugin module lifecycle failed; unrelated modules remain available: ${id}.`, error);
    }
    if (slot.work === work) slot.work = undefined;
    moduleActivity.value++;
    if (slot.intent !== slot.processed) { slot.failure = undefined; void startModuleWork(id, slot); return; }
    if (!slot.desired && !slot.owner && modules.get(id) === slot) modules.delete(id);
  };
  void work.then(() => finished(false), error => finished(true, error));
  return work;
}

async function syncIntent(epoch: number): Promise<{ work: Promise<void>[]; failures: unknown[] }> {
  if (epoch !== metadataEpoch) throw new Error('Web module catalog intent was revoked.');
  const reading = new AbortController(); catalogRead = reading;
  let catalog: Awaited<ReturnType<typeof list>>;
  try { catalog = await list(reading.signal); }
  finally { if (catalogRead === reading) catalogRead = undefined; }
  if (epoch !== metadataEpoch) throw new Error('Web module catalog intent was revoked.');
  const desired = new Map(catalog.modules.map(item => [item.id, item]));
  const work: Promise<void>[] = [];
  deferredReplacement = false;
  for (const [id, slot] of modules) {
    const target = desired.get(id);
    if (catalog.invalidIds.has(id) || (!target && catalog.unidentified)) continue;
    if (slot.owner?.ready && !slot.owner.lifetime.signal.aborted && target && !sameDescriptor(slot.owner.descriptor, target)
      && retainActiveWebPluginModule(slot.owner.descriptor, target)) { deferredReplacement = true; desired.delete(id); continue; }
    slot.desired = target; slot.intent++; slot.failure = undefined;
    if (!target) slot.confirmed = undefined;
    if (slot.owner && (!target || !sameDescriptor(slot.owner.descriptor, target))) cancelOwner(slot.owner);
    work.push(startModuleWork(id, slot)); desired.delete(id);
  }
  for (const [id, descriptor] of desired) {
    const slot: ModuleSlot = { desired: descriptor, intent: 1, processed: 0 };
    modules.set(id, slot); work.push(startModuleWork(id, slot));
  }
  moduleActivity.value++;
  return { work, failures: catalog.failures };
}

/** Reactive intent state only; removed owners remain joined but cannot hold a healthy page loading. */
export function webPluginModulesPending(): boolean {
  void moduleActivity.value;
  return [...modules.values()].some(slot => !!slot.desired && !!slot.work && !slot.failure
    && (!slot.owner?.ready || slot.owner.lifetime.signal.aborted || !sameDescriptor(slot.owner.descriptor, slot.desired)));
}

export async function refreshWebPluginModules(options: Readonly<{ initialization?: "await" | "background" }> = {}): Promise<void> {
  const epoch = metadataEpoch;
  const intent = syncQueue.then(() => syncIntent(epoch));
  syncQueue = intent.then(() => {}, () => {});
  const scheduled = await intent;
  const failures = [...scheduled.failures];
  if (options.initialization !== "background") {
    const settled = await Promise.allSettled(scheduled.work);
    failures.push(...settled.flatMap(result => result.status === "rejected" ? [result.reason] : []));
  }
  if (failures.length) throw new AggregateError(failures, "Some Web plugin modules could not be refreshed.");
}

/** Revoke this snapshot immediately; later explicit catalogs can start independent new owners. */
export function disposeWebPluginModules(): Promise<void> {
  disposing = true; deferredReplacement = false; metadataEpoch++;
  catalogRead?.abort(new Error('Web module catalog intent was revoked.'));
  const work: Promise<unknown>[] = [syncQueue];
  try {
    for (const [id, slot] of modules) {
      slot.desired = undefined; slot.confirmed = undefined; slot.intent++; slot.failure = undefined;
      if (slot.owner) {
        cancelOwner(slot.owner);
        work.push(stopOwner(slot.owner));
      }
      // This per-id producer may consume a later intent; the close receipt
      // above joins only the captured original physical owner.
      void startModuleWork(id, slot);
    }
    moduleActivity.value++;
  } finally { disposing = false; }
  return Promise.allSettled(work).then(settled => {
    const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Web module host retirement is unconfirmed.');
  });
}

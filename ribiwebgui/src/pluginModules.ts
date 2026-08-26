import { h, type Component } from "vue";
import {
  beginTrustedWebPageReplacement,
  notifyTrustedWebPageReplacement,
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

type WebPluginModuleDescriptor = Readonly<{
  id: string;
  instanceId: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
}>;

type WebPluginModuleRegistrationApi = Readonly<{
  id: string;
  instanceId: string;
  pluginId: string;
  version: string;
  h: typeof h;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

type WebPluginModule = Readonly<{
  activate?: (api: WebPluginModuleRegistrationApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;

type ActiveModule = Readonly<{ descriptor: WebPluginModuleDescriptor; dispose: () => void | Promise<void> }>;

const active = new Map<string, ActiveModule>();
let syncQueue: Promise<void> = Promise.resolve();

function validDescriptor(value: unknown): value is WebPluginModuleDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["id", "instanceId", "pluginId", "version", "rev", "entryPath"].every(key => typeof record[key] === "string")
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(record.id as string)
    && record.id === record.instanceId
    && /^[a-f0-9]{64}$/.test(record.rev as string)
    && /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(record.entryPath as string);
}

async function list(): Promise<readonly WebPluginModuleDescriptor[]> {
  const response = await fetch("/api/plugins/modules", { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load Web plugin modules: ${response.status}.`);
  const body = await response.json() as { code?: unknown; data?: { modules?: unknown } };
  if (body.code !== 0 || !Array.isArray(body.data?.modules) || !body.data.modules.every(validDescriptor)) {
    throw new Error("Web plugin module catalog is invalid.");
  }
  const modules = body.data.modules;
  if (new Set(modules.map(item => item.id)).size !== modules.length) throw new Error("Web plugin module catalog has duplicate ids.");
  return Object.freeze([...modules].sort((left, right) => left.id.localeCompare(right.id)));
}

function registrationApi(descriptor: WebPluginModuleDescriptor): WebPluginModuleRegistrationApi {
  const owner = { instanceId: descriptor.instanceId, pluginId: descriptor.pluginId };
  return Object.freeze({
    id: descriptor.id,
    ...owner,
    version: descriptor.version,
    h,
    registerPage: input => registerTrustedWebPage({ ...input, ...owner }),
    registerSettingsRenderer: input => registerTrustedWebSettingsRenderer({ ...input, ...owner }),
    registerStatusRenderer: input => registerTrustedWebStatusRenderer({ ...input, ...owner }),
    registerTheme: input => registerTrustedWebThemeResource({ ...input, ...owner }),
    asComponent: value => value
  });
}

async function importModule(descriptor: WebPluginModuleDescriptor): Promise<WebPluginModule> {
  const url = `/api/plugins/modules/${encodeURIComponent(descriptor.id)}/${descriptor.rev}/${descriptor.entryPath.split("/").map(encodeURIComponent).join("/")}`;
  return await import(/* @vite-ignore */ url) as WebPluginModule;
}

async function activate(descriptor: WebPluginModuleDescriptor): Promise<ActiveModule> {
  const module = await importModule(descriptor);
  if (typeof module.activate !== "function") throw new Error(`Web plugin module does not export activate(): ${descriptor.id}.`);
  const cleanup = await module.activate(registrationApi(descriptor));
  return Object.freeze({ descriptor, dispose: typeof cleanup === "function" ? cleanup : () => {} });
}

async function dispose(module: ActiveModule): Promise<void> {
  await module.dispose();
}

async function syncNow(): Promise<void> {
  const desired = await list();
  const desiredById = new Map(desired.map(item => [item.id, item]));
  for (const [id, loaded] of [...active]) {
    const target = desiredById.get(id);
    if (target && target.rev === loaded.descriptor.rev) continue;
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
    } finally {
      endReplacement();
    }
    notifyTrustedWebPageReplacement();
  }
  for (const descriptor of desired) {
    if (active.has(descriptor.id)) continue;
    active.set(descriptor.id, await activate(descriptor));
  }
}

export function refreshWebPluginModules(): Promise<void> {
  const next = syncQueue.then(syncNow);
  syncQueue = next.catch(() => {});
  return next;
}

export async function disposeWebPluginModules(): Promise<void> {
  await syncQueue;
  for (const module of [...active.values()].reverse()) await dispose(module);
  active.clear();
}

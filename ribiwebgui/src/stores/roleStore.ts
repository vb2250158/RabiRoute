import { computed, onScopeDispose, ref, shallowReactive, watch } from "vue";
import { defineStore } from "pinia";
import type { GatewayDefinition, RuntimeStatus } from "../types";
import { roleConfigurationOf, type RoleConfiguration, type RoleConfigurationRoute } from "@shared/roleConfiguration";
import { automationRulesForGateway } from "../utils/gatewayHelpers";
import { createRoleEditorActions } from "../../../src/plugins/io.rabiroute.manager.persona/web/persona/roleEditorActions";
import { useGatewayStore } from "./gatewayStore";
import { registerPageSaveAction } from "../pageSaveAction";
import { getTimeoutMs } from "../timeoutSettingsClient";
import { previewAccessDenied, readPreview, writePreview } from "../readPreviewCache";
import { remotePersonaServicePath, bootstrapRemotePersonaService } from "../../../src/plugins/io.rabiroute.manager.persona/web/persona/remotePersonaReference";

export type RoleSummary = { roleId: string; title: string; archivedAt: string | null; avatarUrl?: string; avatarConfigured?: boolean; error?: string };
type RoleCatalog = { items: RoleSummary[]; partial: boolean; error: string; loading: boolean; loaded: boolean; cached: boolean };
type CatalogReadOptions = { signal?: AbortSignal; connect?: boolean };
const emptyCatalog: Readonly<RoleCatalog> = { items: [], partial: false, error: "", loading: false, loaded: false, cached: false };
const catalogPreviewKey = (source: string) => ["role-catalog", source];
export type RoleDetail = { roleId: string; archivedAt: string | null; revision: string; roleDir: string; rolePath: string;
  runningWork: number; config: RoleConfiguration; routes: RoleConfigurationRoute[] };

export { roleRequest, mutateRole } from "../roleConfigurationClient";
import { readRoleConfiguration, roleRequest, mutateRole } from "../roleConfigurationClient";

export async function findFirstAvailableRole(source: string): Promise<RoleSummary | undefined> {
  if (source) await bootstrapRemotePersonaService(source);
  let cursor = "";
  do {
    const url = `/api/roles?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(source ? remotePersonaServicePath(source, url) : url);
    const first = page.roles.find(role => !role.error);
    if (first) return first;
    cursor = page.nextCursor || "";
  } while (cursor);
  return undefined;
}

export const useRoleStore = defineStore("roles", () => {
  const routes = useGatewayStore();
  const catalogs = shallowReactive(new Map<string, RoleCatalog>());
  const catalogReads = new Map<string, { controller: AbortController; signal: AbortSignal; promise: Promise<void> }>();
  const catalogRefreshRevision = ref(0);
  const selectedRoleId = ref("");
  const sourceDeviceId = ref("");
  const catalog = computed(() => catalogFor().items);
  const catalogPartial = computed(() => catalogFor().partial);
  const catalogError = computed(() => catalogFor().error);
  const detail = ref<RoleDetail | null>(null);
  const draft = ref<(GatewayDefinition & RoleConfiguration) | null>(null);
  const saved = ref("");
  const loading = ref(false);
  const saving = ref(false);
  const error = ref("");
  let requestVersion = 0;
  const currentConfig = computed(() => draft.value === null ? "" : JSON.stringify(roleConfigurationOf(draft.value)));
  const dirty = computed(() => draft.value !== null && currentConfig.value !== saved.value);
  const archived = computed(() => Boolean(detail.value?.archivedAt));
  const ready = computed(() => Boolean(draft.value && detail.value && !loading.value && !archived.value));
  const selectedGateway = computed(() => draft.value);
  const gateways = computed(() => draft.value ? [draft.value] : []);
  const selectedRuntime = computed<RuntimeStatus>(() => {
    const linked = routes.gateways.find(route => route.agentRoleId === selectedRoleId.value && (route.agentRoleDeviceId || "") === sourceDeviceId.value);
    const runtime = linked ? routes.runtimeFor(linked.id) : {} as RuntimeStatus;
    return { ...runtime, roleInfo: {
      rolesDir: detail.value?.roleDir || "", selectedRolePath: detail.value?.rolePath || "",
      selectedRoleDataDir: detail.value?.roleDir || "", selectedRoleId: selectedRoleId.value,
      options: catalog.value.map(role => ({ value: role.roleId, label: role.title, roleTitle: role.title,
        avatarUrl: role.avatarUrl, avatarConfigured: role.avatarConfigured === true, rolePath: role.roleId === selectedRoleId.value ? detail.value?.rolePath || "" : "" }))
    } };
  });
  const meta = computed(() => routes.meta);
  function endpoint(url: string) { return sourceDeviceId.value ? remotePersonaServicePath(sourceDeviceId.value, url) : url; }
  function catalogFor(source = sourceDeviceId.value): Readonly<RoleCatalog> {
    return catalogs.get(source) || emptyCatalog;
  }
  function restoreCatalogPreview(source: string): void {
    if (catalogs.has(source)) return;
    const items = readPreview<RoleSummary[]>(catalogPreviewKey(source));
    if (Array.isArray(items)) catalogs.set(source, { ...emptyCatalog, items, cached: true });
  }
  function forgetCatalogPreview(source: string): void {
    catalogReads.get(source)?.controller.abort();
    catalogReads.delete(source);
    catalogs.delete(source);
    writePreview(catalogPreviewKey(source), undefined);
  }
  function clearCatalogs(): void {
    for (const read of catalogReads.values()) read.controller.abort();
    catalogReads.clear();
    catalogs.clear();
  }
  watch(() => routes.meta.managerInstanceId, (_current, previous) => {
    if (previous) clearCatalogs();
  }, { flush: "sync" });
  onScopeDispose(clearCatalogs);

  async function readCatalog(source: string, entry: RoleCatalog, connect: boolean, signal: AbortSignal): Promise<void> {
    const previous = entry.items;
    const collected: RoleSummary[] = [];
    let cursor = "";
    try {
      if (source && connect) await bootstrapRemotePersonaService(source, AbortSignal.any([
        signal, AbortSignal.timeout(getTimeoutMs("webgui.persona.remote", 25000))
      ]));
      do {
        signal.throwIfAborted();
        const url = `/api/roles?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(source ? remotePersonaServicePath(source, url) : url, { signal });
        signal.throwIfAborted();
        collected.push(...page.roles.map(role => ({ ...role, avatarUrl: source && role.avatarUrl?.startsWith("/api/") ? remotePersonaServicePath(source, role.avatarUrl) : role.avatarUrl })));
        cursor = page.nextCursor || "";
        entry.partial = Boolean(cursor);
        const received = new Set(collected.map(role => role.roleId));
        entry.items = cursor ? [...collected, ...previous.filter(role => !received.has(role.roleId))] : [...collected];
      } while (cursor);
      entry.loaded = true;
      entry.cached = false;
      writePreview(catalogPreviewKey(source), collected.map(({ roleId, title, archivedAt, avatarUrl, avatarConfigured, error }) => {
        const path = `/api/roles/${encodeURIComponent(roleId)}/avatar`;
        const expected = source ? remotePersonaServicePath(source, path) : path;
        const query = avatarUrl?.startsWith(expected + "?") ? new URLSearchParams(avatarUrl.slice(expected.length + 1)) : undefined;
        const version = query?.get("v");
        return { roleId, title, archivedAt, avatarConfigured, error: error ? "角色读取失败" : undefined,
          avatarUrl: version ? expected + "?v=" + encodeURIComponent(version) : avatarUrl === expected ? expected : undefined };
      }));
    } catch (failure) {
      if (signal.aborted && signal.reason?.name === "AbortError") return;
      const status = (failure as { status?: number }).status;
      if (previewAccessDenied(status)) {
        entry.items = [];
        entry.cached = false;
        writePreview(catalogPreviewKey(source), undefined);
      }
      entry.partial = entry.items.length > 0;
      entry.error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      entry.loading = false;
    }
  }
  function loadCatalog(source = sourceDeviceId.value, options: CatalogReadOptions = {}): Promise<void> {
    restoreCatalogPreview(source);
    catalogReads.get(source)?.controller.abort();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const previous = catalogFor(source);
    const entry = shallowReactive({ ...emptyCatalog, items: previous.items, cached: previous.cached, loading: true });
    catalogs.set(source, entry);
    const promise = readCatalog(source, entry, options.connect !== false, signal).finally(() => {
      if (catalogReads.get(source)?.promise === promise) catalogReads.delete(source);
    });
    catalogReads.set(source, { controller, signal, promise });
    return promise;
  }
  function ensureCatalog(source = sourceDeviceId.value, options?: CatalogReadOptions): Promise<void> {
    const active = catalogReads.get(source);
    if (active && !active.signal.aborted) return active.promise;
    return catalogFor(source).loaded ? Promise.resolve() : loadCatalog(source, options);
  }
  function requestCatalogRefresh(): void {
    catalogRefreshRevision.value++;
  }
  async function load(): Promise<void> {
    const id = selectedRoleId.value;
    const source = sourceDeviceId.value;
    const generation = ++requestVersion;
    if (!id) { draft.value = null; detail.value = null; loading.value = false; return; }
    loading.value = true;
    error.value = "";
    try {
      if (source) await bootstrapRemotePersonaService(source);
      const stillCurrent = () => generation === requestVersion && id === selectedRoleId.value && source === sourceDeviceId.value;
      if (!stillCurrent()) return;
      const result = await readRoleConfiguration<RoleDetail>(endpoint(`/api/roles/${encodeURIComponent(id)}/configuration`), stillCurrent);
      if (!stillCurrent()) return;
      detail.value = result;
      draft.value = { id, gatewayPort: 0, enabled: true, agentRoleId: id, agentRoleFile: "persona.md",
        agentRoleDeviceId: source || undefined, ...result.config };
      automationRulesForGateway(draft.value);
      saved.value = JSON.stringify(roleConfigurationOf(draft.value));
    } catch (failure) { if (generation === requestVersion) { error.value = String(failure instanceof Error ? failure.message : failure); draft.value = null; } }
    finally { if (generation === requestVersion) loading.value = false; }
  }
  async function select(roleId: string, source = sourceDeviceId.value): Promise<void> {
    if (roleId === selectedRoleId.value && source === sourceDeviceId.value && draft.value) return;
    selectedRoleId.value = roleId;
    sourceDeviceId.value = source;
    draft.value = null;
    detail.value = null;
    await load();
  }
  async function refreshLinkedRoutes(): Promise<void> {
    const current = detail.value;
    if (!current) return;
    const source = sourceDeviceId.value;
    try {
      const result = await roleRequest<RoleDetail>(endpoint(`/api/roles/${encodeURIComponent(current.roleId)}/configuration`));
      if (detail.value === current && source === sourceDeviceId.value) current.routes = result.routes;
    } catch (failure) {
      if (detail.value === current && source === sourceDeviceId.value) error.value = failure instanceof Error ? failure.message : String(failure);
    }
  }
  async function save(): Promise<void> {
    if (!ready.value || !draft.value || !detail.value || saving.value) return;
    const id = selectedRoleId.value;
    const source = sourceDeviceId.value;
    const submitted = currentConfig.value;
    const current = draft.value;
    saving.value = true;
    try {
      const result = await mutateRole<RoleDetail>(id, "configuration", { expectedRevision: detail.value.revision, config: JSON.parse(submitted) }, source);
      if (draft.value !== current) return;
      detail.value = result;
      // Preserve edits made while the submitted revision was in flight.
      if (currentConfig.value === submitted) {
        for (const key of Object.keys(roleConfigurationOf(current)) as (keyof RoleConfiguration)[]) {
          if (!(key in result.config)) delete current[key];
        }
        Object.assign(current, result.config);
        saved.value = currentConfig.value;
      } else {
        saved.value = JSON.stringify(result.config);
      }
    } catch (failure) {
      const confirmed = (failure as { confirmedRole?: RoleDetail }).confirmedRole;
      if (confirmed?.roleId === id && confirmed.config && draft.value === current) {
        detail.value = confirmed;
        saved.value = JSON.stringify(confirmed.config);
        return; // Drain the newer draft using the revision from the recovered receipt.
      }
      throw failure;
    } finally { saving.value = false; }
  }
  const saveInput = computed(() => JSON.stringify([detail.value?.revision, currentConfig.value]));
  const backgroundSave = registerPageSaveAction({ dirty, ready, saving, save }, 350, saveInput);
  onScopeDispose(backgroundSave);
  const submitConfig = backgroundSave.flush;
  function flushConfig(): Promise<void> {
    return backgroundSave.failure.value ? Promise.resolve() : backgroundSave.flush();
  }
  function touch() { /* dirty is derived from the independent role draft. */ }
  const actions = createRoleEditorActions(() => draft.value, touch);
  async function openConfigFile(type: string, _routeId = "", roleId = selectedRoleId.value) {
    if (sourceDeviceId.value) {
      const query = new URLSearchParams({ type, roleId });
      await roleRequest(remotePersonaServicePath(sourceDeviceId.value, `/api/open-config-file?${query}`), { method: "POST" });
      return;
    }
    await routes.openConfigFile(type, "", roleId);
  }
  return { catalog, catalogPartial, catalogError, catalogFor, restoreCatalogPreview, forgetCatalogPreview, catalogRefreshRevision, requestCatalogRefresh, selectedRoleId, sourceDeviceId, detail, draft, dirty, archived, ready, loading, saving, error,
    selectedGateway, selectedRuntime, gateways, meta, loadCatalog, ensureCatalog, load, select, refreshLinkedRoutes, submitConfig, flushConfig, touch, openConfigFile, ...actions };
});

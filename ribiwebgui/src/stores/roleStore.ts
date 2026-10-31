import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { GatewayDefinition, RuntimeStatus } from "../types";
import { roleConfigurationOf, type RoleConfiguration } from "@shared/roleConfiguration";
import { automationRulesForGateway } from "../utils/gatewayHelpers";
import { createRoleEditorActions } from "../persona/roleEditorActions";
import { useGatewayStore } from "./gatewayStore";
import { remotePersonaServicePath, bootstrapRemotePersonaService } from "../persona/remotePersonaReference";

export type RoleSummary = { roleId: string; title: string; archivedAt: string | null; avatarUrl?: string; avatarConfigured?: boolean; error?: string };
export type RoleDetail = { roleId: string; archivedAt: string | null; revision: string; roleDir: string; rolePath: string;
  runningWork: number; config: RoleConfiguration; routes: Array<{ id: string; name: string }> };

export { roleRequest, mutateRole } from "../roleConfigurationClient";
import { roleRequest, mutateRole } from "../roleConfigurationClient";

export const useRoleStore = defineStore("roles", () => {
  const routes = useGatewayStore();
  const catalog = ref<RoleSummary[]>([]);
  const selectedRoleId = ref("");
  const sourceDeviceId = ref("");
  const detail = ref<RoleDetail | null>(null);
  const draft = ref<GatewayDefinition | null>(null);
  const saved = ref("");
  const loading = ref(false);
  const saving = ref(false);
  const error = ref("");
  let requestVersion = 0;
  let catalogVersion = 0;
  const dirty = computed(() => draft.value !== null && JSON.stringify(roleConfigurationOf(draft.value)) !== saved.value);
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
  async function loadCatalog(): Promise<void> {
    const generation = ++catalogVersion;
    const source = sourceDeviceId.value;
    if (source) await bootstrapRemotePersonaService(source);
    const collected: RoleSummary[] = [];
    let cursor = "";
    do {
      const url = `/api/roles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(source ? remotePersonaServicePath(source, url) : url);
      if (generation !== catalogVersion || source !== sourceDeviceId.value) return;
      collected.push(...page.roles.map(role => ({ ...role, avatarUrl: source && role.avatarUrl?.startsWith("/api/") ? remotePersonaServicePath(source, role.avatarUrl) : role.avatarUrl })));
      cursor = page.nextCursor || "";
      catalog.value = [...collected];
    } while (cursor);
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
      const result = await roleRequest<RoleDetail>(endpoint(`/api/roles/${encodeURIComponent(id)}/configuration`));
      if (generation !== requestVersion || id !== selectedRoleId.value || source !== sourceDeviceId.value) return;
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
  async function save(): Promise<void> {
    if (!ready.value || !draft.value || !detail.value || saving.value) return;
    const id = selectedRoleId.value;
    const source = sourceDeviceId.value;
    const submitted = JSON.stringify(roleConfigurationOf(draft.value));
    saving.value = true;
    try {
      const result = await mutateRole<RoleDetail>(id, "configuration", { expectedRevision: detail.value.revision, config: JSON.parse(submitted) }, source);
      if (id !== selectedRoleId.value || source !== sourceDeviceId.value) return;
      detail.value = result;
      saved.value = JSON.stringify(result.config);
      // Preserve edits made while the submitted revision was in flight.
      if (draft.value && JSON.stringify(roleConfigurationOf(draft.value)) === submitted) Object.assign(draft.value, result.config);
      await routes.load();
    } catch (failure) {
      const confirmed = (failure as { confirmedRole?: RoleDetail }).confirmedRole;
      if (confirmed?.roleId === id && confirmed.config && id === selectedRoleId.value && source === sourceDeviceId.value) {
        detail.value = confirmed;
        saved.value = JSON.stringify(confirmed.config);
      }
      throw failure;
    } finally { saving.value = false; }
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
  return { catalog, selectedRoleId, sourceDeviceId, detail, draft, dirty, archived, ready, loading, saving, error,
    selectedGateway, selectedRuntime, gateways, meta, loadCatalog, load, select, save, touch, openConfigFile, ...actions };
});

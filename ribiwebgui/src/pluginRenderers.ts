import { defineAsyncComponent, markRaw, ref, type Component, type AsyncComponentLoader } from "vue";

export type WebRendererPlacementId = string;

type TrustedWebRendererBase = Readonly<{
  instanceId: string;
  pluginId: string;
  rendererId: string;
  placementId: WebRendererPlacementId;
  allowedSlots: readonly string[];
  loader: AsyncComponentLoader;
}>;

export type TrustedWebSettingsRendererRegistration = TrustedWebRendererBase & Readonly<{
  schemaId: string;
  readCommandId: string;
  writeCommandId: string;
}>;

export type TrustedWebStatusRendererRegistration = TrustedWebRendererBase & Readonly<{
  queryId: string;
}>;

export type WebRendererContribution = Readonly<{
  key: string;
  id: string;
  instanceId: string;
  pluginId: string;
  rendererId: string;
  placementId: WebRendererPlacementId;
  slot: string;
  order: number;
  component: Component;
}>;

type RegisteredSettingsRenderer = Omit<TrustedWebSettingsRendererRegistration, "loader"> & Readonly<{ component: Component }>;
type RegisteredStatusRenderer = Omit<TrustedWebStatusRendererRegistration, "loader"> & Readonly<{ component: Component }>;
type JsonRecord = Record<string, unknown>;

const settingsRegistry = new Map<string, RegisteredSettingsRenderer>();
const statusRegistry = new Map<string, RegisteredStatusRenderer>();
const rendererRegistrationRevision = ref(0);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}

function controlledSymbol(value: unknown, maximumLength = 160): string {
  const normalized = controlledText(value, maximumLength);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : "";
}

function controlledSymbols(values: readonly string[] | undefined, field: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`Trusted Web renderer ${field} is invalid.`);
  const symbols = values.map(value => controlledSymbol(value, 80));
  if (symbols.some(value => !value) || new Set(symbols).size !== symbols.length) {
    throw new Error(`Trusted Web renderer ${field} is invalid.`);
  }
  return Object.freeze(symbols);
}

function controlledOrder(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && (value as number) >= -10_000 && (value as number) <= 10_000
    ? value as number
    : undefined;
}

function rendererComponent(loader: AsyncComponentLoader): Component {
  if (typeof loader !== "function") throw new Error("Trusted Web renderer loader is invalid.");
  return markRaw(defineAsyncComponent(loader));
}

export function registerTrustedWebSettingsRenderer(input: TrustedWebSettingsRendererRegistration): () => void {
  const rendererId = controlledSymbol(input.rendererId);
  if (!rendererId || settingsRegistry.has(rendererId) || statusRegistry.has(rendererId)) {
    throw new Error(`Trusted Web renderer is already registered or invalid: ${rendererId}`);
  }
  const registration: RegisteredSettingsRenderer = Object.freeze({
    instanceId: controlledSymbol(input.instanceId),
    pluginId: controlledSymbol(input.pluginId),
    rendererId,
    placementId: controlledSymbol(input.placementId),
    allowedSlots: controlledSymbols(input.allowedSlots, "allowedSlots"),
    schemaId: controlledSymbol(input.schemaId),
    readCommandId: controlledSymbol(input.readCommandId),
    writeCommandId: controlledSymbol(input.writeCommandId),
    component: rendererComponent(input.loader)
  });
  if (!registration.instanceId || !registration.pluginId || !registration.placementId || !registration.schemaId || !registration.readCommandId || !registration.writeCommandId) {
    throw new Error("Trusted Web settings renderer registration is invalid.");
  }
  settingsRegistry.set(rendererId, registration);
  rendererRegistrationRevision.value += 1;
  let active = true;
  return () => {
    if (!active || settingsRegistry.get(rendererId) !== registration) return;
    active = false;
    settingsRegistry.delete(rendererId);
    rendererRegistrationRevision.value += 1;
  };
}

export function registerTrustedWebStatusRenderer(input: TrustedWebStatusRendererRegistration): () => void {
  const rendererId = controlledSymbol(input.rendererId);
  if (!rendererId || statusRegistry.has(rendererId) || settingsRegistry.has(rendererId)) {
    throw new Error(`Trusted Web renderer is already registered or invalid: ${rendererId}`);
  }
  const registration: RegisteredStatusRenderer = Object.freeze({
    instanceId: controlledSymbol(input.instanceId),
    pluginId: controlledSymbol(input.pluginId),
    rendererId,
    placementId: controlledSymbol(input.placementId),
    allowedSlots: controlledSymbols(input.allowedSlots, "allowedSlots"),
    queryId: controlledSymbol(input.queryId),
    component: rendererComponent(input.loader)
  });
  if (!registration.instanceId || !registration.pluginId || !registration.placementId || !registration.queryId) {
    throw new Error("Trusted Web status renderer registration is invalid.");
  }
  statusRegistry.set(rendererId, registration);
  rendererRegistrationRevision.value += 1;
  let active = true;
  return () => {
    if (!active || statusRegistry.get(rendererId) !== registration) return;
    active = false;
    statusRegistry.delete(rendererId);
    rendererRegistrationRevision.value += 1;
  };
}

export function registeredWebSettingsRenderers(): readonly RegisteredSettingsRenderer[] {
  return Object.freeze([...settingsRegistry.values()]);
}

export function registeredWebStatusRenderers(): readonly RegisteredStatusRenderer[] {
  return Object.freeze([...statusRegistry.values()]);
}

function parseRendererIdentity(value: JsonRecord, registration: RegisteredSettingsRenderer | RegisteredStatusRenderer): Omit<WebRendererContribution, "component"> | undefined {
  const id = controlledSymbol(value.id, 128);
  const instanceId = controlledSymbol(value.instanceId);
  const pluginId = controlledSymbol(value.pluginId);
  const slot = controlledSymbol(value.slot, 80);
  const order = controlledOrder(value.order);
  if (
    !id
    || !instanceId
    || !pluginId
    || registration.instanceId !== instanceId
    || registration.pluginId !== pluginId
    || !slot
    || order === undefined
    || !registration.allowedSlots.includes(slot)
  ) return undefined;
  return {
    key: `${instanceId}:${id}`,
    id,
    instanceId,
    pluginId,
    rendererId: registration.rendererId,
    placementId: registration.placementId,
    slot,
    order
  };
}

function webHosted(value: JsonRecord): boolean {
  return Array.isArray(value.hosts)
    && value.hosts.every(host => typeof host === "string")
    && value.hosts.includes("web");
}

function parseSettingsRenderer(value: unknown): WebRendererContribution | undefined {
  if (!isRecord(value) || value.kind !== "settings-section" || value.surface !== "shared.settings" || !webHosted(value)) return undefined;
  const rendererId = controlledSymbol(value.rendererId);
  const registration = rendererId ? settingsRegistry.get(rendererId) : undefined;
  if (
    !registration
    || value.schemaId !== registration.schemaId
    || value.readCommandId !== registration.readCommandId
    || value.writeCommandId !== registration.writeCommandId
  ) return undefined;
  const identity = parseRendererIdentity(value, registration);
  return identity ? { ...identity, component: registration.component } : undefined;
}

function parseStatusRenderer(value: unknown): WebRendererContribution | undefined {
  if (!isRecord(value) || value.kind !== "status-card" || value.surface !== "shared.status" || !webHosted(value)) return undefined;
  const rendererId = controlledSymbol(value.rendererId);
  const registration = rendererId ? statusRegistry.get(rendererId) : undefined;
  if (!registration || value.queryId !== registration.queryId) return undefined;
  const identity = parseRendererIdentity(value, registration);
  return identity ? { ...identity, component: registration.component } : undefined;
}

function uniqueSorted(entries: readonly WebRendererContribution[]): readonly WebRendererContribution[] {
  return Object.freeze(entries
    .filter(entry => entries.filter(candidate => candidate.key === entry.key).length === 1
      && entries.filter(candidate => candidate.rendererId === entry.rendererId).length === 1)
    .sort((left, right) => left.order - right.order));
}

export function resolveWebSettingsCatalog(contributions: readonly unknown[] | null): readonly WebRendererContribution[] {
  void rendererRegistrationRevision.value;
  return uniqueSorted((contributions ?? []).flatMap(value => {
    const renderer = parseSettingsRenderer(value);
    return renderer ? [renderer] : [];
  }));
}

export function resolveWebStatusCatalog(contributions: readonly unknown[] | null): readonly WebRendererContribution[] {
  void rendererRegistrationRevision.value;
  return uniqueSorted((contributions ?? []).flatMap(value => {
    const renderer = parseStatusRenderer(value);
    return renderer ? [renderer] : [];
  }));
}

export function webRenderersAt(
  renderers: readonly WebRendererContribution[],
  placementId: WebRendererPlacementId
): readonly WebRendererContribution[] {
  return renderers.filter(renderer => renderer.placementId === placementId);
}

import { ref } from "vue";

export type WebCommandHandlerId = string;
export type WebCommandSlot = string;

export type WebCommandState = Readonly<{
  enabled?: boolean;
  loading?: boolean;
  dirty?: boolean;
}>;

export type WebCommandContext = Readonly<{
  openQuickSetup: () => void;
  addRoute: () => void;
  openManagerConfig: () => void;
  savePage: () => Promise<void>;
  pageSaveState: () => WebCommandState;
  notify: (message: string) => void;
}>;

export type TrustedWebCommandRegistration = Readonly<{
  instanceId: string;
  pluginId: string;
  handlerId: WebCommandHandlerId;
  allowedSlots: readonly WebCommandSlot[];
  allowedIcons: readonly string[];
  appearance?: "default" | "primary";
  execute: (context: WebCommandContext) => void | Promise<void>;
  state?: (context: WebCommandContext) => WebCommandState;
}>;

export type WebCommandContribution = Readonly<{
  key: string;
  id: string;
  instanceId: string;
  pluginId: string;
  handlerId: WebCommandHandlerId;
  slot: WebCommandSlot;
  icon: string;
  label: string;
  order: number;
  appearance: "default" | "primary";
  execute: TrustedWebCommandRegistration["execute"];
  state?: TrustedWebCommandRegistration["state"];
}>;

type JsonRecord = Record<string, unknown>;

const commandRegistry = new Map<WebCommandHandlerId, TrustedWebCommandRegistration>();
const commandRegistrationRevision = ref(0);

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
  if (!Array.isArray(values)) throw new Error(`Trusted Web command ${field} is invalid.`);
  const symbols = values.map(value => controlledSymbol(value, 80));
  if (symbols.some(value => !value) || new Set(symbols).size !== symbols.length) {
    throw new Error(`Trusted Web command ${field} is invalid.`);
  }
  return Object.freeze(symbols);
}

function controlledOrder(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && (value as number) >= -10_000 && (value as number) <= 10_000
    ? value as number
    : undefined;
}

function normalizeRegistration(input: TrustedWebCommandRegistration): TrustedWebCommandRegistration {
  const instanceId = controlledSymbol(input.instanceId);
  const pluginId = controlledSymbol(input.pluginId);
  const handlerId = controlledSymbol(input.handlerId);
  if (!instanceId || !pluginId || !handlerId || typeof input.execute !== "function" || (input.state !== undefined && typeof input.state !== "function")) {
    throw new Error("Trusted Web command registration is invalid.");
  }
  return Object.freeze({
    instanceId,
    pluginId,
    handlerId,
    allowedSlots: controlledSymbols(input.allowedSlots, "allowedSlots"),
    allowedIcons: controlledSymbols(input.allowedIcons, "allowedIcons"),
    appearance: input.appearance === "primary" ? "primary" : "default",
    execute: input.execute,
    ...(input.state ? { state: input.state } : {})
  });
}

export function registerTrustedWebCommand(input: TrustedWebCommandRegistration): () => void {
  const registration = normalizeRegistration(input);
  if (commandRegistry.has(registration.handlerId)) {
    throw new Error(`Trusted Web command handler is already registered: ${registration.handlerId}`);
  }
  commandRegistry.set(registration.handlerId, registration);
  commandRegistrationRevision.value += 1;
  let active = true;
  return () => {
    if (!active || commandRegistry.get(registration.handlerId) !== registration) return;
    active = false;
    commandRegistry.delete(registration.handlerId);
    commandRegistrationRevision.value += 1;
  };
}

export function registeredWebCommands(): readonly TrustedWebCommandRegistration[] {
  return Object.freeze([...commandRegistry.values()]);
}

export function webCommandHandler(handlerId: WebCommandHandlerId): TrustedWebCommandRegistration {
  const registration = commandRegistry.get(handlerId);
  if (!registration) throw new Error(`Web command handler is not registered: ${handlerId}`);
  return registration;
}

function parseWebCommandContribution(value: unknown): WebCommandContribution | undefined {
  if (!isRecord(value) || value.kind !== "command" || value.surface !== "web.commands") return undefined;
  if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) {
    return undefined;
  }
  const id = controlledSymbol(value.id, 128);
  const instanceId = controlledSymbol(value.instanceId);
  const pluginId = controlledSymbol(value.pluginId);
  const handlerId = controlledSymbol(value.handlerId);
  const slot = controlledSymbol(value.slot, 80);
  const icon = controlledSymbol(value.icon, 80);
  const label = isRecord(value.label) ? controlledText(value.label.fallback, 80) : "";
  const order = controlledOrder(value.order);
  const registration = handlerId ? commandRegistry.get(handlerId) : undefined;
  if (
    !id || !instanceId || !pluginId || !registration || !slot || !icon || !label || order === undefined
    || registration.instanceId !== instanceId
    || registration.pluginId !== pluginId
    || !registration.allowedSlots.includes(slot)
    || !registration.allowedIcons.includes(icon)
  ) {
    return undefined;
  }
  return {
    key: `${instanceId}:${id}`,
    id,
    instanceId,
    pluginId,
    handlerId,
    slot,
    icon,
    label,
    order,
    appearance: registration.appearance ?? "default",
    execute: registration.execute,
    ...(registration.state ? { state: registration.state } : {})
  };
}

export function resolveWebCommandCatalog(contributions: readonly unknown[] | null): readonly WebCommandContribution[] {
  void commandRegistrationRevision.value;
  const parsed = (contributions ?? []).flatMap(value => {
    const command = parseWebCommandContribution(value);
    return command ? [command] : [];
  });
  return Object.freeze(parsed
    .filter(command => parsed.filter(candidate => candidate.key === command.key).length === 1
      && parsed.filter(candidate => candidate.handlerId === command.handlerId).length === 1)
    .sort((left, right) => left.order - right.order));
}

export function webCommandsInSlot(
  commands: readonly WebCommandContribution[],
  slot: WebCommandSlot
): readonly WebCommandContribution[] {
  return commands.filter(command => command.slot === slot);
}

export function webCommandForHandler(
  commands: readonly WebCommandContribution[],
  handlerId: WebCommandHandlerId
): WebCommandContribution | undefined {
  return commands.find(command => command.handlerId === handlerId);
}

const builtinWebCommands: readonly TrustedWebCommandRegistration[] = [
  {
    instanceId: "manager:route-control",
    pluginId: "io.rabiroute.manager.route-control",
    handlerId: "web.quick-setup",
    allowedSlots: ["sidebar-footer-primary"],
    allowedIcons: ["mdi-lightning-bolt-outline"],
    appearance: "primary",
    execute: context => context.openQuickSetup()
  },
  {
    instanceId: "manager:route-control",
    pluginId: "io.rabiroute.manager.route-control",
    handlerId: "web.add-route",
    allowedSlots: ["topbar-primary"],
    allowedIcons: ["mdi-plus"],
    execute: context => context.addRoute()
  },
  {
    instanceId: "manager:route-control",
    pluginId: "io.rabiroute.manager.route-control",
    handlerId: "web.open-manager-config",
    allowedSlots: ["sidebar-footer"],
    allowedIcons: ["mdi-folder-cog-outline"],
    execute: context => context.openManagerConfig()
  },
  {
    instanceId: "manager:core",
    pluginId: "io.rabiroute.manager.core",
    handlerId: "web.save-page",
    allowedSlots: ["topbar-primary"],
    allowedIcons: ["mdi-content-save"],
    appearance: "primary",
    execute: async context => {
      await context.savePage();
      context.notify("配置已保存");
    },
    state: context => context.pageSaveState()
  }
];

for (const registration of builtinWebCommands) registerTrustedWebCommand(registration);

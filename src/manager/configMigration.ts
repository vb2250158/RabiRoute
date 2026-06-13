import fs from "node:fs";
import path from "node:path";
import {
  ensureDefaultPersonaRules,
  type GatewayDefinition,
  type NotificationRuleDefinition
} from "../shared/gatewayConfigModel.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath,
  personaConfigPath,
  roleMessageConfigPath,
  routesConfigPath
} from "../shared/routePaths.js";

export type ConfigMigrationOptions = {
  routeRoot: string;
  rolesRoot: string;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function extractNotificationRules(value: unknown): NotificationRuleDefinition[] | undefined {
  if (!isJsonObject(value)) return undefined;
  if (Array.isArray(value.notificationRules) && value.notificationRules.length > 0) {
    return value.notificationRules as NotificationRuleDefinition[];
  }

  const configs = Array.isArray(value.configs) ? value.configs : [];
  const best = configs
    .filter(isJsonObject)
    .sort((a, b) => ((b.notificationRules as unknown[])?.length ?? 0) - ((a.notificationRules as unknown[])?.length ?? 0))[0];
  return Array.isArray(best?.notificationRules) && best.notificationRules.length > 0
    ? best.notificationRules as NotificationRuleDefinition[]
    : undefined;
}

export function mergeNotificationRules(...ruleSets: Array<NotificationRuleDefinition[] | undefined>): NotificationRuleDefinition[] {
  const merged: NotificationRuleDefinition[] = [];
  const seen = new Set<string>();
  for (const rules of ruleSets) {
    for (const rule of rules ?? []) {
      const key = rule.id || `${(rule.routeKinds ?? []).join(",")}:${rule.name ?? ""}:${rule.regex ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}

function defaultPersonaRules(rules: NotificationRuleDefinition[] | undefined): NotificationRuleDefinition[] {
  const next = ensureDefaultPersonaRules(rules);
  const rolePanelIndex = next.findIndex((rule) => rule.id === "role-panel-message");
  if (rolePanelIndex >= 0 && rolePanelIndex < next.length - 1) {
    const [rolePanelRule] = next.splice(rolePanelIndex, 1);
    next.push(rolePanelRule);
  }
  return next;
}

export function readPersonaRules(personaConfigPath: string): NotificationRuleDefinition[] | undefined {
  return extractNotificationRules(readJsonFile(personaConfigPath));
}

export function readPersonaConfigFragment(personaConfigPath: string): Partial<GatewayDefinition> {
  const rules = readPersonaRules(personaConfigPath);
  return rules ? { notificationRules: defaultPersonaRules(rules) } : {};
}

export function writePersonaRules(personaConfigPath: string, rules: NotificationRuleDefinition[] | undefined): void {
  const existing = readJsonFile(personaConfigPath);
  const { configs: _configs, ...base } = isJsonObject(existing) ? existing : {};
  fs.mkdirSync(path.dirname(personaConfigPath), { recursive: true });
  fs.writeFileSync(
    personaConfigPath,
    JSON.stringify({
      ...base,
      notificationRules: defaultPersonaRules(rules)
    }, null, 2),
    "utf8"
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacyRoleRules(rolesRoot: string, roleId: string): NotificationRuleDefinition[] | undefined {
  return mergeNotificationRules(
    extractNotificationRules(readJsonFile(roleMessageConfigPath(rolesRoot, roleId))),
    extractNotificationRules(readJsonFile(routesConfigPath(rolesRoot, roleId)))
  );
}

function routeProfileRulesByRole(raw: JsonObject): Array<{ roleId: string; rules: NotificationRuleDefinition[] }> {
  if (!Array.isArray(raw.routeProfiles)) return [];
  const fallbackRoleId = sanitizeRoleId(typeof raw.agentRoleId === "string" ? raw.agentRoleId : undefined);
  const result: Array<{ roleId: string; rules: NotificationRuleDefinition[] }> = [];
  for (const profile of raw.routeProfiles) {
    if (!isJsonObject(profile) || !Array.isArray(profile.notificationRules)) continue;
    const roleId = sanitizeRoleId(typeof profile.agentRoleId === "string" ? profile.agentRoleId : undefined) || fallbackRoleId;
    if (!roleId) continue;
    result.push({ roleId, rules: profile.notificationRules as NotificationRuleDefinition[] });
  }
  return result;
}

function roleNotificationRulesByRole(raw: JsonObject): Array<{ roleId: string; rules: NotificationRuleDefinition[] }> {
  if (!isJsonObject(raw.roleNotificationRules)) return [];
  const fallbackRoleId = sanitizeRoleId(typeof raw.agentRoleId === "string" ? raw.agentRoleId : undefined);
  const result: Array<{ roleId: string; rules: NotificationRuleDefinition[] }> = [];
  for (const [key, value] of Object.entries(raw.roleNotificationRules)) {
    if (!Array.isArray(value)) continue;
    const roleId = routeRuntimeParts(key).roleId || fallbackRoleId || sanitizeRoleId(key);
    if (!roleId) continue;
    result.push({ roleId, rules: value as NotificationRuleDefinition[] });
  }
  return result;
}

function mergeIntoPersona(rolesRoot: string, roleId: string, rules: NotificationRuleDefinition[] | undefined): void {
  if (!roleId || !rules || rules.length === 0) return;
  const filePath = personaConfigPath(rolesRoot, roleId);
  writePersonaRules(filePath, mergeNotificationRules(readPersonaRules(filePath), rules));
}

function migrateRoleConfig(rolesRoot: string, roleId: string): void {
  const filePath = personaConfigPath(rolesRoot, roleId);
  const current = readPersonaRules(filePath);
  const legacy = legacyRoleRules(rolesRoot, roleId);
  const next = defaultPersonaRules(mergeNotificationRules(current, legacy));
  if (!fs.existsSync(filePath) || !sameJson(defaultPersonaRules(current), next)) {
    writePersonaRules(filePath, next);
  }
  for (const legacyPath of [roleMessageConfigPath(rolesRoot, roleId), routesConfigPath(rolesRoot, roleId)]) {
    if (fs.existsSync(legacyPath)) {
      try { fs.unlinkSync(legacyPath); } catch { /* non-fatal */ }
    }
  }
}

function migrateAdapterConfig(options: ConfigMigrationOptions, configName: string): void {
  const configPath = adapterConfigPath(options.routeRoot, configName);
  const parsed = readJsonFile(configPath);
  if (!isJsonObject(parsed)) return;

  const fallbackRoleId = sanitizeRoleId(typeof parsed.agentRoleId === "string" ? parsed.agentRoleId : undefined);
  if (fallbackRoleId && Array.isArray(parsed.notificationRules)) {
    mergeIntoPersona(options.rolesRoot, fallbackRoleId, parsed.notificationRules as NotificationRuleDefinition[]);
  }
  for (const item of routeProfileRulesByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, item.rules);
  }
  for (const item of roleNotificationRulesByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, item.rules);
  }

  const hasLegacyRuleFields = Array.isArray(parsed.notificationRules)
    || parsed.roleNotificationRules != null
    || parsed.roleRouteNames != null
    || Array.isArray(parsed.routeProfiles);
  if (!hasLegacyRuleFields) return;

  const {
    notificationRules: _notificationRules,
    roleNotificationRules: _roleNotificationRules,
    roleRouteNames: _roleRouteNames,
    routeProfiles: _routeProfiles,
    ...adapterOnly
  } = parsed;
  fs.writeFileSync(configPath, JSON.stringify(adapterOnly, null, 2), "utf8");
}

export function migrateLegacyConfigs(options: ConfigMigrationOptions): void {
  if (fs.existsSync(options.rolesRoot)) {
    for (const entry of fs.readdirSync(options.rolesRoot, { withFileTypes: true })) {
      const roleId = sanitizeRoleId(entry.name);
      if (entry.isDirectory() && roleId) {
        migrateRoleConfig(options.rolesRoot, roleId);
      }
    }
  }

  if (fs.existsSync(options.routeRoot)) {
    for (const entry of fs.readdirSync(options.routeRoot, { withFileTypes: true })) {
      const configName = sanitizeConfigName(entry.name);
      if (entry.isDirectory() && configName && fs.existsSync(adapterConfigPath(options.routeRoot, configName))) {
        migrateAdapterConfig(options, configName);
      }
    }
  }
}

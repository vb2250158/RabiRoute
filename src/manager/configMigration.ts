import fs from "node:fs";
import path from "node:path";
import {
  ensureDefaultPersonaRules,
  normalizeRecentMessageLimits,
  normalizeSpeechTriggerKeywords,
  type GatewayDefinition,
  type NotificationRuleDefinition,
  type RecentMessageLimits
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

export type PersonaConfigFragment = Pick<
  GatewayDefinition,
  "notificationRules" | "recentMessageLimit" | "recentMessageLimits" | "speechTriggerKeywords"
>;

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
  const parsed = readJsonFile(personaConfigPath);
  const rules = readPersonaRules(personaConfigPath);
  const fragment: Partial<GatewayDefinition> = {};
  if (isJsonObject(parsed)) {
    if (isJsonObject(parsed.recentMessageLimits) || parsed.recentMessageLimit != null) {
      fragment.recentMessageLimits = normalizeRecentMessageLimits(
        parsed.recentMessageLimits,
        parsed.recentMessageLimit
      );
    }
    if (Array.isArray(parsed.speechTriggerKeywords)) {
      fragment.speechTriggerKeywords = normalizeSpeechTriggerKeywords(parsed.speechTriggerKeywords);
    }
  }
  if (rules) {
    fragment.notificationRules = defaultPersonaRules(rules);
  }
  return fragment;
}

function normalizedPersonaConfigValue(
  existing: unknown,
  fragment: PersonaConfigFragment,
  options: { materializeDefaults?: boolean } = {}
): JsonObject {
  const raw = isJsonObject(existing) ? existing : {};
  const {
    configs: _configs,
    recentMessageLimit: legacyRecentMessageLimit,
    recentMessageLimits: existingRecentMessageLimits,
    speechTriggerKeywords: existingSpeechTriggerKeywords,
    notificationRules: existingNotificationRules,
    ...base
  } = raw;
  const rules = fragment.notificationRules
    ?? extractNotificationRules({ notificationRules: existingNotificationRules });
  const recentMessageLimits = fragment.recentMessageLimits ?? existingRecentMessageLimits;
  const recentMessageLimit = fragment.recentMessageLimit ?? legacyRecentMessageLimit;
  const speechTriggerKeywords = fragment.speechTriggerKeywords ?? existingSpeechTriggerKeywords;
  const materializeDefaults = options.materializeDefaults !== false;
  return {
    ...base,
    ...(materializeDefaults || isJsonObject(recentMessageLimits) || recentMessageLimit != null
      ? { recentMessageLimits: normalizeRecentMessageLimits(recentMessageLimits, recentMessageLimit) }
      : {}),
    ...(materializeDefaults || Array.isArray(speechTriggerKeywords)
      ? { speechTriggerKeywords: normalizeSpeechTriggerKeywords(speechTriggerKeywords) }
      : {}),
    notificationRules: defaultPersonaRules(rules)
  };
}

function writePersonaConfigValue(
  personaConfigPath: string,
  fragment: PersonaConfigFragment,
  options: { materializeDefaults?: boolean } = {}
): void {
  const existing = readJsonFile(personaConfigPath);
  const next = normalizedPersonaConfigValue(existing, fragment, options);
  if (sameJson(existing, next)) return;
  fs.mkdirSync(path.dirname(personaConfigPath), { recursive: true });
  fs.writeFileSync(personaConfigPath, JSON.stringify(next, null, 2), "utf8");
}

export function writePersonaConfig(
  personaConfigPath: string,
  fragment: PersonaConfigFragment
): void {
  writePersonaConfigValue(personaConfigPath, fragment);
}

export function writePersonaRules(personaConfigPath: string, rules: NotificationRuleDefinition[] | undefined): void {
  writePersonaConfig(personaConfigPath, { notificationRules: rules });
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

function routeProfileFragmentsByRole(raw: JsonObject): Array<{ roleId: string; fragment: PersonaConfigFragment }> {
  if (!Array.isArray(raw.routeProfiles)) return [];
  const fallbackRoleId = sanitizeRoleId(typeof raw.agentRoleId === "string" ? raw.agentRoleId : undefined);
  const result: Array<{ roleId: string; fragment: PersonaConfigFragment }> = [];
  for (const profile of raw.routeProfiles) {
    if (!isJsonObject(profile)) continue;
    const roleId = sanitizeRoleId(typeof profile.agentRoleId === "string" ? profile.agentRoleId : undefined) || fallbackRoleId;
    if (!roleId) continue;
    result.push({
      roleId,
      fragment: {
        notificationRules: Array.isArray(profile.notificationRules)
          ? profile.notificationRules as NotificationRuleDefinition[]
          : undefined,
        recentMessageLimit: profile.recentMessageLimit == null
          ? undefined
          : Number(profile.recentMessageLimit),
        recentMessageLimits: isJsonObject(profile.recentMessageLimits)
          ? profile.recentMessageLimits as RecentMessageLimits
          : undefined,
        speechTriggerKeywords: Array.isArray(profile.speechTriggerKeywords)
          ? profile.speechTriggerKeywords.map(String)
          : undefined
      }
    });
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

function mergeIntoPersona(rolesRoot: string, roleId: string, fragment: PersonaConfigFragment): void {
  if (!roleId) return;
  const filePath = personaConfigPath(rolesRoot, roleId);
  const existing = readJsonFile(filePath);
  const current = readPersonaConfigFragment(filePath);
  const raw = isJsonObject(existing) ? existing : {};
  const hasCurrentLimits = isJsonObject(raw.recentMessageLimits) || raw.recentMessageLimit != null;
  const hasCurrentKeywords = Array.isArray(raw.speechTriggerKeywords);
  writePersonaConfig(filePath, {
    notificationRules: mergeNotificationRules(current.notificationRules, fragment.notificationRules),
    recentMessageLimits: hasCurrentLimits ? current.recentMessageLimits : fragment.recentMessageLimits,
    recentMessageLimit: hasCurrentLimits ? undefined : fragment.recentMessageLimit,
    speechTriggerKeywords: hasCurrentKeywords ? current.speechTriggerKeywords : fragment.speechTriggerKeywords
  });
}

function migrateRoleConfig(rolesRoot: string, roleId: string, materializeDefaults: boolean): void {
  const filePath = personaConfigPath(rolesRoot, roleId);
  const current = readPersonaConfigFragment(filePath);
  const legacy = legacyRoleRules(rolesRoot, roleId);
  writePersonaConfigValue(filePath, {
    ...current,
    notificationRules: mergeNotificationRules(current.notificationRules, legacy)
  }, { materializeDefaults });
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
  if (fallbackRoleId) {
    mergeIntoPersona(options.rolesRoot, fallbackRoleId, {
      notificationRules: Array.isArray(parsed.notificationRules)
        ? parsed.notificationRules as NotificationRuleDefinition[]
        : undefined,
      recentMessageLimit: parsed.recentMessageLimit == null
        ? undefined
        : Number(parsed.recentMessageLimit),
      recentMessageLimits: isJsonObject(parsed.recentMessageLimits)
        ? parsed.recentMessageLimits as RecentMessageLimits
        : undefined,
      speechTriggerKeywords: Array.isArray(parsed.speechTriggerKeywords)
        ? parsed.speechTriggerKeywords.map(String)
        : undefined
    });
  }
  for (const item of routeProfileFragmentsByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, item.fragment);
  }
  for (const item of roleNotificationRulesByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, { notificationRules: item.rules });
  }

  const hasLegacyRuleFields = Array.isArray(parsed.notificationRules)
    || parsed.roleNotificationRules != null
    || parsed.roleRouteNames != null
    || Array.isArray(parsed.routeProfiles)
    || parsed.recentMessageLimit != null
    || parsed.recentMessageLimits != null
    || parsed.speechTriggerKeywords != null;
  if (!hasLegacyRuleFields) return;

  const {
    notificationRules: _notificationRules,
    roleNotificationRules: _roleNotificationRules,
    roleRouteNames: _roleRouteNames,
    routeProfiles: _routeProfiles,
    recentMessageLimit: _recentMessageLimit,
    recentMessageLimits: _recentMessageLimits,
    speechTriggerKeywords: _speechTriggerKeywords,
    ...adapterOnly
  } = parsed;
  const legacySpeechPushMode = Array.isArray(parsed.routeProfiles)
    ? parsed.routeProfiles
        .filter(isJsonObject)
        .map((profile) => profile.speechPushMode)
        .find((value) => value === "hot" || value === "keyword")
    : undefined;
  if (adapterOnly.speechPushMode == null && legacySpeechPushMode != null) {
    adapterOnly.speechPushMode = legacySpeechPushMode;
  }
  fs.writeFileSync(configPath, JSON.stringify(adapterOnly, null, 2), "utf8");
}

export function migrateLegacyConfigs(options: ConfigMigrationOptions): void {
  if (fs.existsSync(options.rolesRoot)) {
    for (const entry of fs.readdirSync(options.rolesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const roleId = sanitizeRoleId(entry.name);
      if (entry.isDirectory() && roleId) {
        migrateRoleConfig(options.rolesRoot, roleId, false);
      }
    }
  }

  if (fs.existsSync(options.routeRoot)) {
    for (const entry of fs.readdirSync(options.routeRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const configName = sanitizeConfigName(entry.name);
      if (entry.isDirectory() && configName && fs.existsSync(adapterConfigPath(options.routeRoot, configName))) {
        migrateAdapterConfig(options, configName);
      }
    }
  }

  if (fs.existsSync(options.rolesRoot)) {
    for (const entry of fs.readdirSync(options.rolesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const roleId = sanitizeRoleId(entry.name);
      if (entry.isDirectory() && roleId) {
        migrateRoleConfig(options.rolesRoot, roleId, true);
      }
    }
  }
}

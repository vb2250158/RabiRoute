import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ensureDefaultPersonaRules,
  ensureDefaultPersonaAutomations,
  mergePersonaAutomationRules,
  normalizePersonaAutomationRules,
  projectGatewayAutomationRules,
  normalizeCodexHookSettings,
  normalizeRecentMessageLimits,
  normalizeSpeechTriggerKeywords,
  notificationRulesFromPersonaAutomations,
  personaAutomationRulesFromNotificationRules,
  type GatewayDefinition,
  type NotificationRuleDefinition,
  type RecentMessageLimits,
  type PersonaAutomationRuleDefinition,
  gatewayAdapterTypes
} from "../shared/gatewayConfigModel.js";
import { normalizeLanguageStyleBinding } from "../shared/languageStyle.js";
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
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { normalizeAgentRoleDeviceId } from "../shared/remotePersonaReference.js";

export type ConfigMigrationOptions = {
  routeRoot: string;
  rolesRoot: string;
};

type JsonObject = Record<string, unknown>;

export type PersonaConfigFragment = Pick<
  GatewayDefinition,
  "automationRules" | "notificationRules" | "recentMessageLimit" | "recentMessageLimits" | "speechTriggerKeywords" | "languageStyle" | "codexHooks"
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

export async function readJsonFileAsync(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as unknown;
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
  const parsed = readJsonFile(personaConfigPath);
  return personaRulesFromValue(parsed);
}

function personaRulesFromValue(parsed: unknown): NotificationRuleDefinition[] | undefined {
  if (isJsonObject(parsed) && Array.isArray(parsed.automationRules)) {
    return notificationRulesFromPersonaAutomations(normalizePersonaAutomationRules(parsed.automationRules));
  }
  return extractNotificationRules(parsed);
}

export function personaConfigFragmentFromValue(parsed: unknown, options: { gatewayProjection?: boolean } = {}): Partial<GatewayDefinition> {
  if (options.gatewayProjection && isJsonObject(parsed)) parsed = { ...parsed, automationRules: projectGatewayAutomationRules(parsed.automationRules) };
  const rules = personaRulesFromValue(parsed);
  const fragment: Partial<GatewayDefinition> = {};
  if (isJsonObject(parsed)) {
    if (parsed.automationScheduleSchemaVersion === 1) fragment.automationScheduleSchemaVersion = 1;
    const configuredAutomations = normalizePersonaAutomationRules(parsed.automationRules);
    fragment.automationRules = Array.isArray(parsed.automationRules)
      ? ensureDefaultPersonaAutomations(configuredAutomations)
      : ensureDefaultPersonaAutomations(personaAutomationRulesFromNotificationRules(rules));
    if (isJsonObject(parsed.recentMessageLimits) || parsed.recentMessageLimit != null) {
      fragment.recentMessageLimits = normalizeRecentMessageLimits(
        parsed.recentMessageLimits,
        parsed.recentMessageLimit
      );
    }
    if (Array.isArray(parsed.speechTriggerKeywords)) {
      fragment.speechTriggerKeywords = normalizeSpeechTriggerKeywords(parsed.speechTriggerKeywords);
    }
    if (parsed.codexHooks != null) {
      fragment.codexHooks = normalizeCodexHookSettings(parsed.codexHooks);
    }
    if (parsed.languageStyle != null) {
      fragment.languageStyle = normalizeLanguageStyleBinding(parsed.languageStyle);
    }
  }
  if (rules) {
    fragment.notificationRules = defaultPersonaRules(rules);
  }
  return fragment;
}

export function readPersonaConfigFragment(personaConfigPath: string, options: { gatewayProjection?: boolean } = {}): Partial<GatewayDefinition> {
  return personaConfigFragmentFromValue(readJsonFile(personaConfigPath), options);
}

export async function readPersonaConfigFragmentAsync(personaConfigPath: string, options: { gatewayProjection?: boolean } = {}): Promise<Partial<GatewayDefinition>> {
  return personaConfigFragmentFromValue(await readJsonFileAsync(personaConfigPath), options);
}

function normalizedPersonaConfigValue(
  existing: unknown,
  fragment: PersonaConfigFragment,
  options: { materializeDefaults?: boolean; scheduleSchemaVersion?: 1 } = {}
): JsonObject {
  const raw = isJsonObject(existing) ? existing : {};
  const {
    configs: _configs,
    recentMessageLimit: legacyRecentMessageLimit,
    recentMessageLimits: existingRecentMessageLimits,
    speechTriggerKeywords: existingSpeechTriggerKeywords,
    languageStyle: existingLanguageStyle,
    codexHooks: existingHooks,
    automationRules: existingAutomationRules,
    notificationRules: existingNotificationRules,
    ...base
  } = raw;
  const rules = fragment.notificationRules
    ?? extractNotificationRules({ notificationRules: existingNotificationRules });
  const recentMessageLimits = fragment.recentMessageLimits ?? existingRecentMessageLimits;
  const recentMessageLimit = fragment.recentMessageLimit ?? legacyRecentMessageLimit;
  const speechTriggerKeywords = fragment.speechTriggerKeywords ?? existingSpeechTriggerKeywords;
  const languageStyle = fragment.languageStyle ?? existingLanguageStyle;
  const configuredAutomations = normalizePersonaAutomationRules(fragment.automationRules ?? existingAutomationRules);
  const automationRules = ensureDefaultPersonaAutomations(Array.isArray(fragment.automationRules ?? existingAutomationRules)
    ? configuredAutomations
    : personaAutomationRulesFromNotificationRules(rules));
  const materializeDefaults = options.materializeDefaults !== false;
  return {
    ...base,
    ...(options.scheduleSchemaVersion ? { automationScheduleSchemaVersion: options.scheduleSchemaVersion } : {}),
    ...((fragment.codexHooks ?? existingHooks) != null
      ? { codexHooks: normalizeCodexHookSettings(fragment.codexHooks ?? existingHooks) }
      : {}),
    ...(materializeDefaults || isJsonObject(recentMessageLimits) || recentMessageLimit != null
      ? { recentMessageLimits: normalizeRecentMessageLimits(recentMessageLimits, recentMessageLimit) }
      : {}),
    ...(materializeDefaults || Array.isArray(speechTriggerKeywords)
      ? { speechTriggerKeywords: normalizeSpeechTriggerKeywords(speechTriggerKeywords) }
      : {}),
    ...(languageStyle != null ? { languageStyle: normalizeLanguageStyleBinding(languageStyle) } : {}),
    automationRules
  };
}

function writePersonaConfigValue(
  personaConfigPath: string,
  fragment: PersonaConfigFragment,
  options: { materializeDefaults?: boolean; scheduleSchemaVersion?: 1 } = {}
): void {
  const existing = readJsonFile(personaConfigPath);
  const next = normalizedPersonaConfigValue(existing, fragment, options);
  const roleId = path.basename(path.dirname(personaConfigPath));
  if (sameJson(existing, next)) {
    recordDataMutationAudit({
      group: "config",
      event: "persona_config_migration_unchanged",
      owner: "config-migration",
      action: "migrate-persona-config",
      target: { type: "persona", id: roleId },
      dataSource: { kind: "file", id: `roles/${roleId}/${path.basename(personaConfigPath)}` },
      outcome: "no_change"
    });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(personaConfigPath), { recursive: true });
    fs.writeFileSync(personaConfigPath, JSON.stringify(next, null, 2), "utf8");
    recordDataMutationAudit({
      group: "config",
      event: "persona_config_migration_committed",
      owner: "config-migration",
      action: "migrate-persona-config",
      target: { type: "persona", id: roleId },
      dataSource: { kind: "file", id: `roles/${roleId}/${path.basename(personaConfigPath)}` },
      outcome: "committed",
      changes: Object.keys(next).sort().map(field => ({ field }))
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "config",
      event: "persona_config_migration_failed",
      owner: "config-migration",
      action: "migrate-persona-config",
      target: { type: "persona", id: roleId },
      dataSource: { kind: "file", id: `roles/${roleId}/${path.basename(personaConfigPath)}` },
      outcome: "failed",
      error
    });
    throw error;
  }
}

export function writePersonaConfig(
  personaConfigPath: string,
  fragment: PersonaConfigFragment,
  options: { scheduleSchemaVersion?: 1 } = {}
): void {
  writePersonaConfigValue(personaConfigPath, fragment, options);
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
    if (normalizeAgentRoleDeviceId(profile.agentRoleDeviceId)) continue;
    const roleId = sanitizeRoleId(typeof profile.agentRoleId === "string" ? profile.agentRoleId : undefined) || fallbackRoleId;
    if (!roleId) continue;
    result.push({
      roleId,
      fragment: {
        automationRules: Array.isArray(profile.automationRules)
          ? normalizePersonaAutomationRules(profile.automationRules)
          : undefined,
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

function mergeIntoPersona(rolesRoot: string, roleId: string, fragment: PersonaConfigFragment, legacyIntervalSeconds = 900): void {
  if (!roleId) return;
  const filePath = personaConfigPath(rolesRoot, roleId);
  const existing = readJsonFile(filePath);
  const current = readPersonaConfigFragment(filePath);
  const raw = isJsonObject(existing) ? existing : {};
  const hasCurrentLimits = isJsonObject(raw.recentMessageLimits) || raw.recentMessageLimit != null;
  const hasCurrentKeywords = Array.isArray(raw.speechTriggerKeywords);
  writePersonaConfig(filePath, {
    automationRules: mergePersonaAutomationRules(
      current.automationRules,
      fragment.automationRules,
      personaAutomationRulesFromNotificationRules(fragment.notificationRules, legacyIntervalSeconds),
      existing === undefined ? ensureDefaultPersonaAutomations(undefined) : []
    ),
    codexHooks: current.codexHooks ?? fragment.codexHooks,
    languageStyle: current.languageStyle ?? fragment.languageStyle,
    recentMessageLimits: hasCurrentLimits ? current.recentMessageLimits : fragment.recentMessageLimits,
    recentMessageLimit: hasCurrentLimits ? undefined : fragment.recentMessageLimit,
    speechTriggerKeywords: hasCurrentKeywords ? current.speechTriggerKeywords : fragment.speechTriggerKeywords
  });
}

function migrateRoleConfig(rolesRoot: string, roleId: string, materializeDefaults: boolean): void {
  const filePath = personaConfigPath(rolesRoot, roleId);
  const raw = readJsonFile(filePath);
  const current = readPersonaConfigFragment(filePath);
  const legacy = legacyRoleRules(rolesRoot, roleId);
  writePersonaConfigValue(filePath, {
    ...current,
    automationRules: mergePersonaAutomationRules(
      current.automationRules,
      personaAutomationRulesFromNotificationRules(legacy),
      !isJsonObject(raw) || !Array.isArray(raw.automationRules) ? ensureDefaultPersonaAutomations(undefined) : []
    )
  }, { materializeDefaults });
  for (const legacyPath of [roleMessageConfigPath(rolesRoot, roleId), routesConfigPath(rolesRoot, roleId)]) {
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
        recordDataMutationAudit({
          group: "config",
          event: "legacy_role_config_removed",
          owner: "config-migration",
          action: "remove-legacy-role-config",
          target: { type: "persona", id: roleId },
          dataSource: { kind: "file", id: `roles/${roleId}/${path.basename(legacyPath)}` },
          outcome: "committed"
        });
      } catch (error) {
        recordDataMutationAudit({
          level: "warn",
          group: "config",
          event: "legacy_role_config_remove_failed",
          owner: "config-migration",
          action: "remove-legacy-role-config",
          target: { type: "persona", id: roleId },
          dataSource: { kind: "file", id: `roles/${roleId}/${path.basename(legacyPath)}` },
          outcome: "failed",
          error
        });
      }
    }
  }
}

function migrateAdapterConfig(options: ConfigMigrationOptions, configName: string): void {
  const configPath = adapterConfigPath(options.routeRoot, configName);
  const parsed = readJsonFile(configPath);
  if (!isJsonObject(parsed)) return;
  // Remote persona references own no local persona configuration to migrate.
  if (normalizeAgentRoleDeviceId(parsed.agentRoleDeviceId)) return;

  const fallbackRoleId = sanitizeRoleId(typeof parsed.agentRoleId === "string" ? parsed.agentRoleId : undefined);
  if (fallbackRoleId) {
    mergeIntoPersona(options.rolesRoot, fallbackRoleId, {
      languageStyle: parsed.languageStyle != null ? normalizeLanguageStyleBinding(parsed.languageStyle) : undefined,
      codexHooks: parsed.codexHooks != null ? normalizeCodexHookSettings(parsed.codexHooks) : undefined,
      automationRules: Array.isArray(parsed.automationRules)
        ? normalizePersonaAutomationRules(parsed.automationRules)
        : undefined,
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
    }, Number(parsed.heartbeatIntervalSeconds) || 900);
  }
  for (const item of routeProfileFragmentsByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, item.fragment, Number(parsed.heartbeatIntervalSeconds) || 900);
  }
  for (const item of roleNotificationRulesByRole(parsed)) {
    mergeIntoPersona(options.rolesRoot, item.roleId, { notificationRules: item.rules });
  }

  const hasLegacyRuleFields = (fallbackRoleId && parsed.codexHooks != null)
    || (fallbackRoleId && parsed.languageStyle != null)
    || Array.isArray(parsed.automationRules)
    || Array.isArray(parsed.notificationRules)
    || parsed.roleNotificationRules != null
    || parsed.roleRouteNames != null
    || Array.isArray(parsed.routeProfiles)
    || parsed.recentMessageLimit != null
    || parsed.recentMessageLimits != null
    || parsed.speechTriggerKeywords != null;
  if (!hasLegacyRuleFields || (!fallbackRoleId && !Array.isArray(parsed.routeProfiles))) return;

  const {
    automationRules: _automationRules,
    notificationRules: _notificationRules,
    roleNotificationRules: _roleNotificationRules,
    roleRouteNames: _roleRouteNames,
    routeProfiles: _routeProfiles,
    recentMessageLimit: _recentMessageLimit,
    recentMessageLimits: _recentMessageLimits,
    speechTriggerKeywords: _speechTriggerKeywords,
    ...adapterOnly
  } = parsed;
  if (fallbackRoleId) delete adapterOnly.codexHooks;
  if (fallbackRoleId) delete adapterOnly.languageStyle;
  const legacySpeechPushMode = Array.isArray(parsed.routeProfiles)
    ? parsed.routeProfiles
        .filter(isJsonObject)
        .map((profile) => profile.speechPushMode)
        .find((value) => value === "hot" || value === "keyword")
    : undefined;
  if (adapterOnly.speechPushMode == null && legacySpeechPushMode != null) {
    adapterOnly.speechPushMode = legacySpeechPushMode;
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(adapterOnly, null, 2), "utf8");
    recordDataMutationAudit({
      group: "config",
      event: "adapter_config_migration_committed",
      owner: "config-migration",
      action: "migrate-adapter-config",
      target: { type: "adapter-config", id: configName },
      dataSource: { kind: "file", id: `routes/${configName}/${path.basename(configPath)}` },
      outcome: "committed",
      changes: Object.keys(adapterOnly).sort().map(field => ({ field }))
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "config",
      event: "adapter_config_migration_failed",
      owner: "config-migration",
      action: "migrate-adapter-config",
      target: { type: "adapter-config", id: configName },
      dataSource: { kind: "file", id: `routes/${configName}/${path.basename(configPath)}` },
      outcome: "failed",
      error
    });
    throw error;
  }
}

type LegacyScheduleRoute = { id: string; value: JsonObject; file: string };

/** Preserve the old connector's per-Route opt-in once, then let Automation own new schedules. */
export function migrateScheduledAutomationConnector(options: ConfigMigrationOptions): void {
  const routes: LegacyScheduleRoute[] = [];
  if (fs.existsSync(options.routeRoot)) for (const entry of fs.readdirSync(options.routeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeConfigName(entry.name)) continue;
    const file = adapterConfigPath(options.routeRoot, entry.name);
    const value = readJsonFile(file);
    if (isJsonObject(value)) routes.push({ id: sanitizeConfigName(entry.name), value, file });
  }
  const enabledRoutes = routes.filter(route => gatewayAdapterTypes({ ...route.value, id: route.id } as GatewayDefinition).includes("heartbeat"));
  const knownRouteIds = new Set(routes.map(route => route.id));
  function migrateRules(value: JsonObject, candidates: LegacyScheduleRoute[]): JsonObject {
    if (value.automationScheduleSchemaVersion === 1) return value;
    const rules = Array.isArray(value.automationRules) ? normalizePersonaAutomationRules(value.automationRules)
      : personaAutomationRulesFromNotificationRules(value.notificationRules as NotificationRuleDefinition[] | undefined, Number(value.heartbeatIntervalSeconds) || 900);
    const automationRules = rules.map((rule, index) => {
      const original = Array.isArray(value.automationRules) && isJsonObject(value.automationRules[index])
        ? value.automationRules[index] : rule;
      if (rule.trigger.type !== "schedule") return original;
      const originalTrigger = isJsonObject(original.trigger) ? original.trigger : rule.trigger;
      const originalSchedule = isJsonObject(originalTrigger.schedule) ? originalTrigger.schedule : rule.trigger.schedule;
      const sources = candidates.filter(route => !rule.sourceRouteIds?.length || rule.sourceRouteIds.includes(route.id));
      const activeSourceIds = new Set(sources.map(route => route.id));
      const explicitSources = rule.sourceRouteIds?.length ? rule.sourceRouteIds : undefined;
      const unknownSources = explicitSources?.filter(id => !knownRouteIds.has(id)) ?? [];
      const retainedSources = explicitSources
        ? explicitSources.filter(id => !knownRouteIds.has(id) || activeSourceIds.has(id))
        : sources.map(route => route.id);
      const busyPolicies = new Set(sources.map(route => route.value.heartbeatSkipWhenAgentBusy === true));
      // An unavailable original source stays scoped and can be recovered later. A known
      // disabled-only scope remains nonempty and disabled; [] would mean every Route.
      // Only migration controls change; normalized action/target objects never replace
      // the originals or strip their nested extension fields.
      return { ...original, enabled: rule.enabled !== false && retainedSources.length > 0,
        sourceRouteIds: retainedSources.length ? retainedSources : explicitSources ?? rule.sourceRouteIds,
        trigger: { ...originalTrigger, schedule: { ...originalSchedule,
          ...(rule.trigger.schedule.skipWhenAgentBusy === undefined && !unknownSources.length && busyPolicies.size === 1
            ? { skipWhenAgentBusy: [...busyPolicies][0] } : {}) } } };
    });
    return { ...value, automationRules, automationScheduleSchemaVersion: 1 };
  }
  function commit(file: string, before: JsonObject, after: JsonObject): void {
    if (sameJson(before, after)) return;
    try {
      fs.writeFileSync(file, JSON.stringify(after, null, 2), "utf8");
      recordDataMutationAudit({ group: "config", event: "automation_schedule_migration_committed", owner: "config-migration",
        action: "migrate-scheduled-automation", target: { type: "config", id: path.basename(path.dirname(file)) },
        dataSource: { kind: "file", id: path.basename(file) }, outcome: "committed" });
    } catch (error) {
      recordDataMutationAudit({ level: "error", group: "config", event: "automation_schedule_migration_failed", owner: "config-migration",
        action: "migrate-scheduled-automation", target: { type: "config", id: path.basename(path.dirname(file)) },
        dataSource: { kind: "file", id: path.basename(file) }, outcome: "failed", error });
      throw error;
    }
  }
  // The explicit personaConfigUpgrade maintenance owner stages these changes and snapshots all originals before applying them.
  if (fs.existsSync(options.rolesRoot)) for (const entry of fs.readdirSync(options.rolesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) continue;
    const file = personaConfigPath(options.rolesRoot, entry.name);
    const value = readJsonFile(file);
    if (!isJsonObject(value)) continue;
    const migrated = migrateRules(value, enabledRoutes.filter(route => !normalizeAgentRoleDeviceId(route.value.agentRoleDeviceId) && (route.value.agentRoleId === entry.name
      || (Array.isArray(route.value.routeProfiles) && route.value.routeProfiles.some(profile => isJsonObject(profile)
        && !normalizeAgentRoleDeviceId(profile.agentRoleDeviceId) && (sanitizeRoleId(profile.agentRoleId) || sanitizeRoleId(route.value.agentRoleId)) === entry.name)))));
    // Keep unrelated role rules and settings byte-value equivalent in the dedicated migration.
    const { automationRules, codexHooks, recentMessageLimits, speechTriggerKeywords, languageStyle, ...base } = migrated;
    commit(file, value, migrated === value ? value : { ...base,
      ...(codexHooks !== undefined ? { codexHooks } : {}),
      ...(recentMessageLimits !== undefined ? { recentMessageLimits } : {}),
      ...(speechTriggerKeywords !== undefined ? { speechTriggerKeywords } : {}),
      ...(languageStyle !== undefined ? { languageStyle } : {}), automationRules });
  }
  for (const route of routes) {
    const value = !sanitizeRoleId(route.value.agentRoleId) && !normalizeAgentRoleDeviceId(route.value.agentRoleDeviceId)
      ? migrateRules(route.value, enabledRoutes.filter(candidate => candidate.id === route.id)) : { ...route.value };
    const configured = Array.isArray(value.messageAdapters) ? value.messageAdapters : [value.messageAdapterType ?? "napcat"];
    if (!configured.includes("heartbeat")) { commit(route.file, route.value, value); continue; }
    const messageAdapters = configured.filter(type => type !== "heartbeat");
    const policies = isJsonObject(value.messageAdapterPolicies) ? { ...value.messageAdapterPolicies } : undefined;
    if (policies) delete policies.heartbeat;
    const next: JsonObject = { ...value, messageAdapters, messageAdapterType: messageAdapters[0],
      ...(Array.isArray(value.messageAdaptersDisabled) ? { messageAdaptersDisabled: value.messageAdaptersDisabled.filter(type => type !== "heartbeat") } : {}),
      ...(policies ? { messageAdapterPolicies: policies } : {}) };
    // Legacy busy policy remains available when shared-role Routes had different values.
    delete next.heartbeatIntervalSeconds;
    delete next.heartbeatMessage;
    commit(route.file, route.value, next);
  }
}

/** Capture raw Route intervals before the older role split materializes a shared 900-second default. */
function captureLegacyScheduleRules(options: ConfigMigrationOptions): Map<string, Map<string, PersonaAutomationRuleDefinition[]>> {
  const groups = new Map<string, Map<string, Map<string, PersonaAutomationRuleDefinition>>>();
  function capture(roleId: string, routeId: string, rule: PersonaAutomationRuleDefinition): void {
    if (rule.trigger.type !== "schedule" || (rule.sourceRouteIds?.length && !rule.sourceRouteIds.includes(routeId))) return;
    const byId = groups.get(roleId) ?? new Map<string, Map<string, PersonaAutomationRuleDefinition>>(); groups.set(roleId, byId);
    const variants = byId.get(rule.id) ?? new Map<string, PersonaAutomationRuleDefinition>(); byId.set(rule.id, variants);
    const { sourceRouteIds: _source, ...content } = rule;
    const signature = JSON.stringify(content);
    const existing = variants.get(signature);
    if (existing) existing.sourceRouteIds = [...new Set([...existing.sourceRouteIds ?? [], routeId])];
    else variants.set(signature, { ...rule, sourceRouteIds: [routeId] });
  }
  if (!fs.existsSync(options.routeRoot)) return new Map();
  for (const entry of fs.readdirSync(options.routeRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !sanitizeConfigName(entry.name)) continue;
    const route = readJsonFile(adapterConfigPath(options.routeRoot, entry.name));
    if (!isJsonObject(route) || normalizeAgentRoleDeviceId(route.agentRoleDeviceId)) continue;
    const roleId = sanitizeRoleId(route.agentRoleId);
    // Profiles may belong to another local role, and their own rules override the Route defaults.
    if (Array.isArray(route.routeProfiles)) for (const profile of route.routeProfiles) {
      if (!isJsonObject(profile) || normalizeAgentRoleDeviceId(profile.agentRoleDeviceId)) continue;
      const profileRoleId = sanitizeRoleId(profile.agentRoleId) || roleId;
      if (!profileRoleId) continue;
      const owner = readJsonFile(personaConfigPath(options.rolesRoot, profileRoleId));
      if (isJsonObject(owner) && owner.automationScheduleSchemaVersion === 1) continue;
      const explicitIds = new Set(isJsonObject(owner) && Array.isArray(owner.automationRules)
        ? normalizePersonaAutomationRules(owner.automationRules).map(rule => rule.id) : []);
      const profileRules = Array.isArray(profile.automationRules) ? normalizePersonaAutomationRules(profile.automationRules)
        : personaAutomationRulesFromNotificationRules(profile.notificationRules as NotificationRuleDefinition[] | undefined,
          Number(route.heartbeatIntervalSeconds) || 900);
      for (const rule of profileRules) if (!explicitIds.has(rule.id)) capture(profileRoleId, entry.name,
        { ...rule, enabled: rule.enabled !== false && profile.enabled !== false });
    }
    if (!roleId) continue;
    const persona = readJsonFile(personaConfigPath(options.rolesRoot, roleId));
    if (isJsonObject(persona) && persona.automationScheduleSchemaVersion === 1) continue;
    const explicitRules = isJsonObject(persona) && Array.isArray(persona.automationRules)
      ? normalizePersonaAutomationRules(persona.automationRules) : [];
    const legacyRules = mergeNotificationRules(
      isJsonObject(persona) && !Array.isArray(persona.automationRules) ? extractNotificationRules(persona) : undefined,
      legacyRoleRules(options.rolesRoot, roleId),
      !Array.isArray(route.automationRules) && Array.isArray(route.notificationRules) ? route.notificationRules as NotificationRuleDefinition[] : undefined
    );
    for (const rule of personaAutomationRulesFromNotificationRules(legacyRules, Number(route.heartbeatIntervalSeconds) || 900)) {
      if (rule.trigger.type !== "schedule" || explicitRules.some(existing => existing.id === rule.id)) continue;
      capture(roleId, entry.name, rule);
    }
  }
  return new Map([...groups].map(([roleId, byId]) => [roleId, new Map([...byId].map(([id, variants]) => [id,
    [...variants].map(([signature, rule], index) => ({ ...rule, id: index === 0 ? id : `${id}-schedule-${createHash("sha256").update(signature).digest("hex").slice(0, 10)}` }))
  ]))]));
}

function restoreCapturedLegacySchedules(options: ConfigMigrationOptions, captured: Map<string, Map<string, PersonaAutomationRuleDefinition[]>>): void {
  for (const [roleId, replacements] of captured) {
    const file = personaConfigPath(options.rolesRoot, roleId);
    const value = readPersonaConfigFragment(file);
    const existing = normalizePersonaAutomationRules(value.automationRules);
    const rules = existing.flatMap(rule => rule.trigger.type === "schedule" && replacements.has(rule.id)
      ? replacements.get(rule.id)! : [rule]);
    for (const [id, variants] of replacements) if (!existing.some(rule => rule.id === id)) rules.push(...variants);
    writePersonaConfigValue(file, { ...value, automationRules: rules }, { materializeDefaults: false });
  }
}

export function migrateLegacyConfigs(options: ConfigMigrationOptions): void {
  const legacySchedules = captureLegacyScheduleRules(options);
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
  restoreCapturedLegacySchedules(options, legacySchedules);
  migrateScheduledAutomationConnector(options);
}

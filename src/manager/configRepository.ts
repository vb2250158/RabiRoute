import fs from "node:fs";
import { createHash } from "node:crypto";
import { withFileLockSync } from "../shared/filePersistence.js";
import {BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, type ComputerSettingsDefinition, type ComputerSettingsRead, type ComputerFeature, type ComputerFeaturePolicy} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import { migrateAgentDeliveryFiles } from "./agentDeliveryMigrationFiles.js";
import { normalizeAgentDeliveryTarget, validateAgentDeliveryTarget } from "../shared/agentDeliveryTarget.js";
import path from "node:path";
import {
  autoAssignGatewayPorts,
  ensureDefaultPersonaRules,
  ensureDefaultPersonaAutomations,
  mergePersonaAutomationRules,
  normalizeGatewayDefinition,
  validateGatewayPortConflicts,
  type GatewayConfigFile,
  type GatewayDefinition,
  type NotificationRuleDefinition
} from "../shared/gatewayConfigModel.js";
import { toPersistedProjectPath } from "../shared/projectPaths.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath as resolveAdapterConfigPath,
  personaConfigPath as resolvePersonaConfigPath,
  routeFolderPath
} from "../shared/routePaths.js";
import { normalizeAgentAdapters } from "../agentAdapters/types.js";
import { normalizePipelineDefinition } from "../pipelines.js";
import {
  mergeNotificationRules,
  migrateLegacyConfigs,
  readPersonaConfigFragment,
  readPersonaConfigFragmentAsync,
  writePersonaConfig as writePersonaConfigFile,
  writePersonaRules
} from "./configMigration.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { normalizeRemotePersonaReference, removePersonaOwnedGatewayConfig } from "../shared/remotePersonaReference.js";

export type ManagerConfig = {
  computerSettings?: unknown;
  [key: string]: unknown;
  routeDir?: string;
  rolesDir?: string;
};


export type ManagerDataDomain = "roles" | "route";
export type ManagerDomainRoot = Readonly<{ value?: string; rawValue?: unknown; error?: Readonly<{ code: "MANAGER_DIRECTORY_INVALID"; field: "rolesDir" | "routeDir"; message: string }> }>;

export type ManagerConfigRepositoryOptions = {
  rootDir: string;
  managerPort: number;
  resolveComputerDefinition?: () => ComputerSettingsDefinition | undefined;
  routeRoot?: string;
  rolesRoot?: string;
};

export function migrateLegacyCopilotThreadName(
  definition: Partial<GatewayDefinition>
): Partial<GatewayDefinition> {
  const adapters = normalizeAgentAdapters(definition.agentAdapters);
  const legacyThreadName = definition.codexThreadName?.trim();
  if (adapters.length !== 1 || adapters[0] !== "copilotCli" || definition.copilotThreadName?.trim() || !legacyThreadName) {
    return definition;
  }

  const migrated = {
    ...definition,
    copilotThreadName: legacyThreadName
  };
  delete migrated.codexThreadName;
  return migrated;
}

export class ManagerConfigRepository {
  readonly rootDir: string;
  private currentManagerPort: number;
  private readonly computerFeaturePolicyCache = new Map<ComputerFeature,ComputerFeaturePolicy>();
  private computerSettingsRawCache?: { value: unknown };
  private computerSettingsCache?: ComputerSettingsRead;
  private computerExecutionSettingsCache?: {value:unknown};
  private currentComputerDefinition=BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION;
  private readonly resolveComputerDefinition?:()=>ComputerSettingsDefinition|undefined;
  private routeRootResolution!: ManagerDomainRoot;
  private rolesRootResolution!: ManagerDomainRoot;
  get routeRoot(): string { return this.requireDomainRoot("route"); }
  set routeRoot(value: string) { this.routeRootResolution = this.resolveDomainRoot("route", value); }
  get rolesRoot(): string { return this.requireDomainRoot("roles"); }
  set rolesRoot(value: string) { this.rolesRootResolution = this.resolveDomainRoot("roles", value); }
  domainRoot(domain: ManagerDataDomain): ManagerDomainRoot { return domain === "roles" ? this.rolesRootResolution : this.routeRootResolution; }
  requireDomainRoot(domain: ManagerDataDomain): string {
    const result = this.domainRoot(domain);
    if (result.error) throw Object.assign(new Error(result.error.message), result.error, { status: 503 });
    return result.value!;
  }
  private resolveDomainRoot(domain: ManagerDataDomain, value: unknown): ManagerDomainRoot {
    const field = domain === "roles" ? "rolesDir" : "routeDir";
    if (typeof value !== "string" || !value.trim() || value.includes(String.fromCharCode(0))) return Object.freeze({ rawValue: value, error: Object.freeze({ code: "MANAGER_DIRECTORY_INVALID" as const, field, message: `Invalid manager.json ${field}; repair this directory setting. The original value was preserved.` }) });
    return Object.freeze({ value: path.resolve(this.rootDir, value), rawValue: value });
  }

  constructor(options: ManagerConfigRepositoryOptions) {
    this.rootDir = options.rootDir;
    this.resolveComputerDefinition=options.resolveComputerDefinition;
    this.currentManagerPort = options.managerPort;
    const cfg = this.readManagerConfig();
    this.routeRoot = options.routeRoot ?? cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route");
    this.rolesRoot = options.rolesRoot ?? cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles");
  }

  get managerConfigPath(): string {
    return path.join(this.rootDir, "data", "manager.json");
  }

  readManagerConfig(strict = false): ManagerConfig {
    if (!fs.existsSync(this.managerConfigPath)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(this.managerConfigPath, "utf8"));
      if (strict && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid Manager configuration object.");
      return value as ManagerConfig;
    } catch (error) {
      if (strict) throw Object.assign(new Error("The original data/manager.json configuration is invalid or unavailable; its bytes were not changed."),{code:"COMPUTER_SETTINGS_INVALID",field:"computerSettings"});
      return {};
    }
  }

    readComputerFeaturePolicy(feature:ComputerFeature, refresh=false): ComputerFeaturePolicy {
    const definition=this.getComputerSettingsDefinition();
    if(refresh)this.computerFeaturePolicyCache.delete(feature);
    const cached=this.computerFeaturePolicyCache.get(feature);if(cached)return cached;
    const policy=definition.projectFeaturePolicy(this.readComputerSettingsRaw(refresh),feature);
    this.computerFeaturePolicyCache.set(feature,policy);return policy;
  }

  getComputerSettingsDefinition():ComputerSettingsDefinition {
    const value=this.resolveComputerDefinition?.()??this.currentComputerDefinition;
    if(value!==this.currentComputerDefinition){this.currentComputerDefinition=value;this.computerSettingsCache=undefined;this.computerExecutionSettingsCache=undefined;this.computerFeaturePolicyCache.clear();}
    return value;
  }
  readComputerExecutionSettings():unknown {
    const definition=this.getComputerSettingsDefinition();
    if(!this.computerExecutionSettingsCache)this.computerExecutionSettingsCache={value:definition.materialize(this.readComputerSettingsRaw())};
    return this.computerExecutionSettingsCache.value;
  }
  readComputerSettingsRaw(refresh = false): unknown {
    if (refresh) this.computerSettingsRawCache = undefined;
    if (!this.computerSettingsRawCache) this.computerSettingsRawCache = { value: this.readManagerConfig(true).computerSettings };
    return this.computerSettingsRawCache.value;
  }

    readComputerSettings(refresh = false): ComputerSettingsRead {
    const definition=this.getComputerSettingsDefinition();
    if(refresh){this.computerSettingsCache=undefined;this.computerSettingsRawCache=undefined;this.computerExecutionSettingsCache=undefined;this.computerFeaturePolicyCache.clear();}
    if(this.computerSettingsCache)return this.computerSettingsCache;
    const rawSettings=this.readComputerSettingsRaw(),settings=this.readComputerExecutionSettings();
    const revision='"sha256:'+createHash("sha256").update(JSON.stringify([definition.digest,rawSettings===undefined?{absent:true}:{present:true,value:rawSettings}])).digest("hex")+'"';
    return this.computerSettingsCache={settings,rawSettings,revision,schema:definition.schema,defaults:definition.defaults,definitionDigest:definition.digest,diagnostics:definition.diagnose(settings)};
  }

    patchComputerSettings(patch: unknown, expectedRevision: string, restorePaths: readonly string[] = []): ComputerSettingsRead {
    withFileLockSync(`${this.managerConfigPath}.lock`,()=>{
      const definition=this.getComputerSettingsDefinition(),current=this.readComputerSettings(true);
      if(current.revision!==expectedRevision)throw Object.assign(new Error("Computer settings revision conflict. Read the original computer-settings before merging."),{code:"COMPUTER_SETTINGS_CONFLICT"});
      const config=this.readManagerConfig(true);
      this.writeManagerConfig({...config,computerSettings:definition.patchRaw(this.readComputerSettingsRaw(),patch,restorePaths)});
    });
    return this.readComputerSettings();
  }

  refreshManagerConfig(): ManagerConfig {
    this.computerSettingsCache = undefined;this.computerSettingsRawCache = undefined;this.computerExecutionSettingsCache = undefined;
    this.computerFeaturePolicyCache.clear();
    const cfg = this.readManagerConfig();
    this.routeRoot = cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route");
    this.rolesRoot = cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles");
    return cfg;
  }

  writeManagerConfig(cfg: ManagerConfig): void {
    if (!Object.hasOwn(cfg,"computerSettings")) {
      const saved = this.readManagerConfig().computerSettings;
      if (saved !== undefined) cfg = {...cfg,computerSettings:saved};
    }
    this.computerSettingsCache = undefined;this.computerSettingsRawCache = undefined;this.computerExecutionSettingsCache = undefined;
    this.computerFeaturePolicyCache.clear();
    const existed = fs.existsSync(this.managerConfigPath);
    try {
      fs.mkdirSync(path.dirname(this.managerConfigPath), { recursive: true });
      fs.writeFileSync(this.managerConfigPath, JSON.stringify(cfg, null, 2), "utf8");
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "config",
        event: "manager_config_write_failed",
        owner: "config-repository",
        action: existed ? "replace" : "create",
        target: { type: "manager-config", id: "manager" },
        dataSource: { kind: "file", id: "data/manager.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "config",
      event: "manager_config_written",
      owner: "config-repository",
      action: existed ? "replace" : "create",
      target: { type: "manager-config", id: "manager" },
      dataSource: { kind: "file", id: "data/manager.json" },
      outcome: "committed",
      changes: Object.keys(cfg).sort().map(field => ({ field }))
    });
    this.routeRoot = cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route");
    this.rolesRoot = cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles");
  }

  ensureDataDirs(): void {
    const exampleDataDir = path.join(this.rootDir, "examples", "data");
    const exampleManagerConfig = path.join(exampleDataDir, "manager.json");
    if (!fs.existsSync(this.managerConfigPath) && fs.existsSync(exampleManagerConfig)) {
      fs.mkdirSync(path.dirname(this.managerConfigPath), { recursive: true });
      fs.copyFileSync(exampleManagerConfig, this.managerConfigPath, fs.constants.COPYFILE_EXCL);
      recordDataMutationAudit({
        group: "config",
        event: "default_manager_config_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "manager-config", id: "manager" },
        dataSource: { kind: "file", id: "data/manager.json" },
        outcome: "committed"
      });
      this.refreshManagerConfig();
    }
    if (this.domainRoot("roles").value && !fs.existsSync(this.rolesRoot) && fs.existsSync(path.join(exampleDataDir, "roles"))) {
      fs.mkdirSync(path.dirname(this.rolesRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "roles"), this.rolesRoot, { recursive: true, force: false, errorOnExist: false });
      recordDataMutationAudit({
        group: "persona",
        event: "default_roles_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "role-catalog", id: "roles" },
        dataSource: { kind: "file", id: "data/roles" },
        outcome: "committed"
      });
    }
    if (this.domainRoot("route").value && !fs.existsSync(this.routeRoot) && fs.existsSync(path.join(exampleDataDir, "route"))) {
      fs.mkdirSync(path.dirname(this.routeRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "route"), this.routeRoot, { recursive: true, force: false, errorOnExist: false });
      recordDataMutationAudit({
        group: "route",
        event: "default_routes_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "route-catalog", id: "routes" },
        dataSource: { kind: "file", id: "data/route" },
        outcome: "committed"
      });
    }
    if (this.domainRoot("roles").value) fs.mkdirSync(this.rolesRoot, { recursive: true });
    if (this.domainRoot("route").value) fs.mkdirSync(this.routeRoot, { recursive: true });
    // Do not synchronously traverse and rewrite every role on Manager startup.
    // rolesRoot may be NAS-backed; a broad legacy migration here can prevent the
    // local control-plane listener from ever coming up. Call migrateLegacyConfigs
    // only from an explicit maintenance/migration workflow.
  }

  async ensureDataDirsAsync(): Promise<void> {
    const exists = async (target: string): Promise<boolean> => {
      try {
        await fs.promises.access(target);
        return true;
      } catch {
        return false;
      }
    };
    const exampleDataDir = path.join(this.rootDir, "examples", "data");
    const exampleManagerConfig = path.join(exampleDataDir, "manager.json");
    if (!await exists(this.managerConfigPath) && await exists(exampleManagerConfig)) {
      await fs.promises.mkdir(path.dirname(this.managerConfigPath), { recursive: true });
      let copied = false;
      try {
        await fs.promises.copyFile(exampleManagerConfig, this.managerConfigPath, fs.constants.COPYFILE_EXCL);
        copied = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (copied) {
        recordDataMutationAudit({
          group: "config",
          event: "default_manager_config_installed",
          owner: "config-repository",
          action: "install-default",
          target: { type: "manager-config", id: "manager" },
          dataSource: { kind: "file", id: "data/manager.json" },
          outcome: "committed"
        });
      }
      this.refreshManagerConfig();
    }
    if (this.domainRoot("roles").value && !await exists(this.rolesRoot) && await exists(path.join(exampleDataDir, "roles"))) {
      await fs.promises.mkdir(path.dirname(this.rolesRoot), { recursive: true });
      await fs.promises.cp(path.join(exampleDataDir, "roles"), this.rolesRoot, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      recordDataMutationAudit({
        group: "persona",
        event: "default_roles_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "role-catalog", id: "roles" },
        dataSource: { kind: "file", id: "data/roles" },
        outcome: "committed"
      });
    }
    if (this.domainRoot("route").value && !await exists(this.routeRoot) && await exists(path.join(exampleDataDir, "route"))) {
      await fs.promises.mkdir(path.dirname(this.routeRoot), { recursive: true });
      await fs.promises.cp(path.join(exampleDataDir, "route"), this.routeRoot, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      recordDataMutationAudit({
        group: "route",
        event: "default_routes_installed",
        owner: "config-repository",
        action: "install-default",
        target: { type: "route-catalog", id: "routes" },
        dataSource: { kind: "file", id: "data/route" },
        outcome: "committed"
      });
    }
    await Promise.all([
      ...(this.domainRoot("roles").value ? [fs.promises.mkdir(this.rolesRoot, { recursive: true })] : []),
      ...(this.domainRoot("route").value ? [fs.promises.mkdir(this.routeRoot, { recursive: true })] : [])
    ]);
  }

  get managerPort(): number {
    return this.currentManagerPort;
  }

  setManagerPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Manager port must be an integer from 1 to 65535; received ${port}.`);
    }
    this.currentManagerPort = port;
  }

  adapterConfigPath(configName: string): string {
    return resolveAdapterConfigPath(this.routeRoot, configName);
  }

  readRoleMessageConfig(roleId: string | undefined, agentRoleDeviceId?: string): Partial<GatewayDefinition> {
    if (normalizeRemotePersonaReference({ agentRoleId: roleId, agentRoleDeviceId }).agentRoleDeviceId) return {};
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return {};
    return readPersonaConfigFragment(this.personaConfigPath(safeRoleId), { gatewayProjection: true });
  }

  async readRoleMessageConfigAsync(roleId: string | undefined, agentRoleDeviceId?: string): Promise<Partial<GatewayDefinition>> {
    if (normalizeRemotePersonaReference({ agentRoleId: roleId, agentRoleDeviceId }).agentRoleDeviceId) return {};
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return {};
    return readPersonaConfigFragmentAsync(this.personaConfigPath(safeRoleId), { gatewayProjection: true });
  }

  personaConfigPath(roleId: string): string {
    return resolvePersonaConfigPath(this.rolesRoot, roleId);
  }

  writePersonaRules(roleId: string, rules: NotificationRuleDefinition[] | undefined): void {
    writePersonaRules(this.personaConfigPath(roleId), rules);
  }

  writePersonaConfig(
    roleId: string,
    fragment: Pick<
      GatewayDefinition,
      "automationRules" | "notificationRules" | "recentMessageLimit" | "recentMessageLimits" | "speechTriggerKeywords" | "languageStyle" | "codexHooks"
    >
  ): void {
    for (const rule of fragment.automationRules ?? []) {
      if (rule.action.type === "deliver_agent") {
        if (!rule.action.target) throw new Error("Agent delivery target is required; migrate legacy rules before saving.");
        validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
      }
    }
    writePersonaConfigFile(this.personaConfigPath(roleId), {
      ...fragment,
      automationRules: fragment.automationRules === undefined
        ? undefined
        : ensureDefaultPersonaAutomations(fragment.automationRules),
      notificationRules: fragment.notificationRules === undefined
        ? undefined
        : ensureDefaultPersonaRules(mergeNotificationRules(fragment.notificationRules))
    });
  }

  private configPathValue(value: unknown): string | undefined {
    return toPersistedProjectPath(value, this.rootDir);
  }

  migrateLegacyConfigs(): void {
    const explicitTargets = new Map<string, Set<string>>();
    if (fs.existsSync(this.rolesRoot)) for (const entry of fs.readdirSync(this.rolesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = this.personaConfigPath(entry.name);
      if (!fs.existsSync(file)) continue;
      const persona = JSON.parse(fs.readFileSync(file, "utf8"));
      explicitTargets.set(entry.name, new Set((persona.automationRules ?? []).filter((rule: any) => rule.action?.target !== undefined).map((rule: any) => rule.id)));
    }
    migrateLegacyConfigs({ routeRoot: this.routeRoot, rolesRoot: this.rolesRoot });
    const routesByRole = new Map<string, string[]>();
    if (fs.existsSync(this.routeRoot)) for (const entry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = this.adapterConfigPath(entry.name);
      if (!fs.existsSync(file)) continue;
      const route = JSON.parse(fs.readFileSync(file, "utf8"));
      const roleId = sanitizeRoleId(route.agentRoleId);
      if (!roleId || route.agentRoleDeviceId || !fs.existsSync(this.personaConfigPath(roleId))) continue;
      routesByRole.set(roleId, [...routesByRole.get(roleId) ?? [], file]);
    }
    for (const [roleId, routePaths] of routesByRole) migrateAgentDeliveryFiles({
      personaPath: this.personaConfigPath(roleId), routePaths, apply: true,
      explicitTargetRuleIds: explicitTargets.get(roleId) ?? new Set()
    });
  }

  normalize(definition: GatewayDefinition): GatewayDefinition {
    const { agentRoleDeviceId } = normalizeRemotePersonaReference(definition);
    const localDefinition = agentRoleDeviceId
      ? this.adapterConfigItem(definition) as GatewayDefinition
      : definition;
    return normalizeGatewayDefinition(localDefinition, {
      managerPort: this.managerPort,
      routeDataDir: (configName) => path.relative(this.rootDir, routeFolderPath(this.routeRoot, configName)).replace(/\\/g, "/"),
      rolesDir: path.relative(this.rootDir, this.rolesRoot).replace(/\\/g, "/"),
      normalizeAgentAdapters,
      normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
    });
  }

  readConfig(): GatewayConfigFile {
    this.ensureDataDirs();
    const gateways: GatewayDefinition[] = [];
    for (const routeEntry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
      const configName = sanitizeConfigName(routeEntry.name);
      const configPath = this.adapterConfigPath(configName);
      if (!fs.existsSync(configPath)) continue;
      const raw = migrateLegacyCopilotThreadName(
        JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>
      );
      const { agentRoleDeviceId } = normalizeRemotePersonaReference(raw);
      const personaConfig = agentRoleDeviceId ? {} : this.readRoleMessageConfig(raw.agentRoleId);
      gateways.push(this.normalize({
        ...raw,
        ...personaConfig,
        id: configName,
        configName,
        agentRoleId: raw.agentRoleId,
        agentRoleDeviceId,
        rolesDir: raw.rolesDir,
        agentRoleFile: raw.agentRoleFile
      } as GatewayDefinition));
    }
    return { gateways };
  }

  private removeConfigFilesMissingFrom(activeConfigNames: Set<string>): void {
    if (!fs.existsSync(this.routeRoot)) return;
    for (const routeEntry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
      const configName = sanitizeConfigName(routeEntry.name);
      if (!configName || activeConfigNames.has(configName)) continue;
      const configPath = this.adapterConfigPath(configName);
      if (fs.existsSync(configPath)) {
        try { fs.unlinkSync(configPath); } catch { /* non-fatal */ }
      }
    }
  }

  writeConfig(config: GatewayConfigFile, scope?: { configName: string; previousId: string }): GatewayConfigFile {
    if (!Array.isArray(config.gateways)) throw new Error("routes must be an array");
    for (const gateway of config.gateways) {
      const configName = sanitizeConfigName(gateway.configName) || routeRuntimeParts(gateway.id).configName;
      if (scope && configName !== scope.configName) continue;
      for (const rule of gateway.automationRules ?? []) {
        if (rule.action.type === "deliver_agent") {
          if (!rule.action.target) throw new Error("Agent delivery target is required; migrate legacy rules before saving.");
          validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
        }
      }
    }
    const normalized = { gateways: config.gateways.map((definition) => this.normalize(definition)) };
    autoAssignGatewayPorts(normalized.gateways, this.managerPort);
    validateGatewayPortConflicts(normalized.gateways);
    const activeConfigNames = new Set<string>();
    for (let i = 0; i < normalized.gateways.length; i += 1) {
      const definition = normalized.gateways[i];
      const raw = config.gateways[i];
      const oldConfigName = routeRuntimeParts(raw.id).configName || sanitizeConfigName(raw.configName);
      const configName = sanitizeConfigName(definition.configName) || definition.id;
      activeConfigNames.add(configName);
      if (scope && configName !== scope.configName) continue;
      if (oldConfigName && oldConfigName !== configName) {
        const oldConfigPath = this.adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
      const configPath = this.adapterConfigPath(configName);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(this.adapterConfigItem(definition), null, 2), "utf8");
    }
    // Role-owned data is committed only through the independent role configuration owner.
    if (scope) {
      const previousName = routeRuntimeParts(scope.previousId).configName || sanitizeConfigName(scope.previousId);
      if (previousName && previousName !== scope.configName) {
        const oldPath = this.adapterConfigPath(previousName);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    } else this.removeConfigFilesMissingFrom(activeConfigNames);
    return normalized;
  }

  private adapterConfigItem(definition: GatewayDefinition): Partial<GatewayDefinition> {
    const {
      routeProfiles: _routeProfiles,
      dataDir: _dataDir,
      rabiLinkRelayEnabled: _rabiLinkRelayEnabled,
      rabiLinkRelayUrl: _rabiLinkRelayUrl,
      rabiLinkRelayToken: _rabiLinkRelayToken,
      rabiLinkRelayDeviceId: _rabiLinkRelayDeviceId,
      rabiLinkRelayClaimWaitMs: _rabiLinkRelayClaimWaitMs,
      rabiLinkRelayReplyIdleTimeoutMs: _rabiLinkRelayReplyIdleTimeoutMs,
      ...adapterOnly
    } = removePersonaOwnedGatewayConfig(definition);
    return {
      ...adapterOnly,
      ...(!definition.agentRoleId ? { codexHooks: definition.codexHooks } : {}),
      remoteAgentDefaultCwd: this.configPathValue(adapterOnly.remoteAgentDefaultCwd),
      codexCwd: this.configPathValue(adapterOnly.codexCwd),
      copilotCwd: this.configPathValue(adapterOnly.copilotCwd),
      rolesDir: this.configPathValue(adapterOnly.rolesDir),
      routesDir: this.configPathValue(adapterOnly.routesDir),
      napcatInstances: Array.isArray(adapterOnly.napcatInstances)
        ? adapterOnly.napcatInstances.map((instance) => ({
            ...instance,
            workingDir: this.configPathValue(instance.workingDir)
          }))
        : adapterOnly.napcatInstances
    };
  }
}

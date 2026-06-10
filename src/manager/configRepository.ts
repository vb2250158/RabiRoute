import fs from "node:fs";
import path from "node:path";
import {
  autoAssignGatewayPorts,
  normalizeGatewayDefinition,
  routeRuntimeParts,
  sanitizeRoleId,
  validateGatewayPortConflicts,
  type GatewayConfigFile,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";
import { normalizeAgentAdapters } from "../agentAdapters/types.js";
import { normalizePipelineDefinition } from "../pipelines.js";

export type ManagerConfig = {
  routeDir?: string;
  rolesDir?: string;
};

export type ManagerConfigRepositoryOptions = {
  rootDir: string;
  managerPort: number;
  routeRoot?: string;
  rolesRoot?: string;
};

export class ManagerConfigRepository {
  readonly rootDir: string;
  readonly managerPort: number;
  routeRoot: string;
  rolesRoot: string;

  constructor(options: ManagerConfigRepositoryOptions) {
    this.rootDir = options.rootDir;
    this.managerPort = options.managerPort;
    const cfg = this.readManagerConfig();
    this.routeRoot = path.resolve(this.rootDir, options.routeRoot ?? cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
    this.rolesRoot = path.resolve(this.rootDir, options.rolesRoot ?? cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
  }

  get managerConfigPath(): string {
    return path.join(this.rootDir, "data", "manager.json");
  }

  readManagerConfig(): ManagerConfig {
    if (!fs.existsSync(this.managerConfigPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.managerConfigPath, "utf8")) as ManagerConfig;
    } catch {
      return {};
    }
  }

  writeManagerConfig(cfg: ManagerConfig): void {
    fs.mkdirSync(path.dirname(this.managerConfigPath), { recursive: true });
    fs.writeFileSync(this.managerConfigPath, JSON.stringify(cfg, null, 2), "utf8");
    this.routeRoot = path.resolve(this.rootDir, cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
    this.rolesRoot = path.resolve(this.rootDir, cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
  }

  ensureDataDirs(): void {
    const exampleDataDir = path.join(this.rootDir, "examples", "data");
    if (!fs.existsSync(this.rolesRoot) && fs.existsSync(path.join(exampleDataDir, "roles"))) {
      fs.mkdirSync(path.dirname(this.rolesRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "roles"), this.rolesRoot, { recursive: true, force: false, errorOnExist: false });
    }
    if (!fs.existsSync(this.routeRoot) && fs.existsSync(path.join(exampleDataDir, "route"))) {
      fs.mkdirSync(path.dirname(this.routeRoot), { recursive: true });
      fs.cpSync(path.join(exampleDataDir, "route"), this.routeRoot, { recursive: true, force: false, errorOnExist: false });
    }
    fs.mkdirSync(this.rolesRoot, { recursive: true });
    fs.mkdirSync(this.routeRoot, { recursive: true });
  }

  adapterConfigPath(configName: string): string {
    const safeConfigName = sanitizeRoleId(configName);
    if (!safeConfigName) throw new Error("Missing route folder name");
    return path.join(this.routeRoot, safeConfigName, "adapterConfig.json");
  }

  readRoleMessageConfig(roleId: string | undefined): Partial<GatewayDefinition> {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) return {};
    const configPath = this.personaConfigPath(safeRoleId);
    if (!fs.existsSync(configPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
      return Array.isArray(parsed.notificationRules) ? { notificationRules: parsed.notificationRules } : {};
    } catch {
      return {};
    }
  }

  personaConfigPath(roleId: string): string {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) throw new Error("Missing role folder name");
    return path.join(this.rolesRoot, safeRoleId, "personaConfig.json");
  }

  normalize(definition: GatewayDefinition): GatewayDefinition {
    return normalizeGatewayDefinition(definition, {
      managerPort: this.managerPort,
      routeDataDir: (configName) => path.relative(this.rootDir, path.join(this.routeRoot, configName)).replace(/\\/g, "/"),
      rolesDir: path.relative(this.rootDir, this.rolesRoot).replace(/\\/g, "/"),
      normalizeAgentAdapters: (adapters) => normalizeAgentAdapters(adapters ?? []),
      normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
    });
  }

  readConfig(): GatewayConfigFile {
    this.ensureDataDirs();
    const gateways: GatewayDefinition[] = [];
    for (const routeEntry of fs.readdirSync(this.routeRoot, { withFileTypes: true })) {
      if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) continue;
      const configName = sanitizeRoleId(routeEntry.name);
      const configPath = this.adapterConfigPath(configName);
      if (!fs.existsSync(configPath)) continue;
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
      const personaConfig = (Array.isArray(raw.notificationRules) && raw.notificationRules.length > 0)
        ? {}
        : this.readRoleMessageConfig(raw.agentRoleId);
      gateways.push(this.normalize({
        ...raw,
        ...personaConfig,
        id: configName,
        configName,
        agentRoleId: raw.agentRoleId,
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
      const configName = sanitizeRoleId(routeEntry.name);
      if (!configName || activeConfigNames.has(configName)) continue;
      const configPath = this.adapterConfigPath(configName);
      if (fs.existsSync(configPath)) {
        try { fs.unlinkSync(configPath); } catch { /* non-fatal */ }
      }
    }
  }

  writeConfig(config: GatewayConfigFile): GatewayConfigFile {
    if (!Array.isArray(config.gateways)) throw new Error("routes must be an array");
    const normalized = { gateways: config.gateways.map((definition) => this.normalize(definition)) };
    autoAssignGatewayPorts(normalized.gateways, this.managerPort);
    validateGatewayPortConflicts(normalized.gateways);
    const activeConfigNames = new Set<string>();
    for (let i = 0; i < normalized.gateways.length; i += 1) {
      const definition = normalized.gateways[i];
      const raw = config.gateways[i];
      const oldConfigName = routeRuntimeParts(raw.id).configName || sanitizeRoleId(raw.configName);
      const configName = sanitizeRoleId(definition.configName) || definition.id;
      activeConfigNames.add(configName);
      if (oldConfigName && oldConfigName !== configName) {
        const oldConfigPath = this.adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
      const configPath = this.adapterConfigPath(configName);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(definition, null, 2), "utf8");
    }
    this.removeConfigFilesMissingFrom(activeConfigNames);
    return normalized;
  }
}

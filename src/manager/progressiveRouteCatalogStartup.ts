import path from "node:path";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { normalizePersonaFile } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { BoundedStorageStartup, type StorageAttempt, type StorageStartupLimits } from "./boundedStorageStartup.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";
import { createStorageStartupProcess } from "./storageStartupProcess.js";
import type { StartupProcessFactory } from "./progressivePlanStorageStartup.js";
import type { RouteCatalogPersonaPresentation, RouteCatalogSnapshot, RouteCatalogTransactionInput } from "./routeCatalogTransaction.js";

export class ProgressiveRouteCatalogStartup {
  private readonly gateways = new Map<string, GatewayDefinition>();
  private readonly personas = new Map<string, RouteCatalogPersonaPresentation>();
  private roots?: string;

  constructor(private readonly options: Readonly<{
    limits?: StorageStartupLimits;
    terminateTimeoutMs?: number;
    processFactory?: StartupProcessFactory;
  }> = {}) {}

  attempt(
    input: RouteCatalogTransactionInput,
    onProgress: (snapshot: RouteCatalogSnapshot) => void | Promise<void>,
    baseline?: RouteCatalogSnapshot
  ): StorageAttempt<RouteCatalogSnapshot> {
    const roots = JSON.stringify([input.rootDir, input.routeRoot, input.rolesRoot, input.managerPort]);
    if (roots !== this.roots) {
      this.gateways.clear();
      this.personas.clear();
      this.roots = roots;
    }
    if (baseline && baseline.routeRoot === input.routeRoot && baseline.rolesRoot === input.rolesRoot) {
      this.gateways.clear();
      this.personas.clear();
      for (const definition of baseline.gateways) this.gateways.set(definition.configName || definition.id, structuredClone(definition));
      for (const persona of baseline.personas) {
        this.personas.set(JSON.stringify([persona.rolesRoot, persona.roleId]), structuredClone(persona));
      }
    }
    const scope = new BoundedStorageStartup(this.options.limits);
    const create: StartupProcessFactory = this.options.processFactory
      ?? (task => createStorageStartupProcess(task, this.options.terminateTimeoutMs));
    let failures = 0;
    let enumeratedRoutes = false;
    const snapshot = (incomplete: boolean): RouteCatalogSnapshot => {
      const content = {
        routeRoot: input.routeRoot,
        rolesRoot: input.rolesRoot,
        gateways: [...this.gateways.values()].sort((left, right) => left.id.localeCompare(right.id)),
        personas: [...this.personas.values()].sort((left, right) =>
          left.rolesRoot.localeCompare(right.rolesRoot) || left.roleId.localeCompare(right.roleId))
      };
      return structuredClone({
        requestId: input.requestId,
        attemptToken: input.attemptToken,
        ...content,
        ...routeCatalogSnapshotIdentities(content),
        startupIncomplete: incomplete,
        startupFailureCount: failures
      });
    };
    let publication = Promise.resolve();
    const publish = (): Promise<void> => {
      publication = publication.then(() => onProgress(snapshot(true)));
      return publication;
    };
    const failed = async (): Promise<void> => {
      failures += 1;
      if (enumeratedRoutes || this.gateways.size || this.personas.size) await publish();
    };
    const result = (async () => {
      await scope.run([input],
        taskInput => create<boolean>({ kind: "catalog_recovery", input: taskInput }),
        () => {}, failed);
      if (failures) return snapshot(true);
      let routeNames: string[] | undefined;
      await scope.run([input.routeRoot],
        root => create<string[]>({ kind: "directories", root, catalog: "routes" }),
        async (_root, names) => { routeNames = names; enumeratedRoutes = true; await publish(); }, failed);
      if (routeNames) {
        const discovered = new Set(routeNames);
        for (const name of this.gateways.keys()) if (!discovered.has(name)) this.gateways.delete(name);
        await scope.run(routeNames,
          configName => create<GatewayDefinition | null>({ kind: "route", input, configName }),
          async (name, definition) => {
            if (definition) this.gateways.set(name, definition);
            else this.gateways.delete(name);
            await publish();
          }, failed);
      }
      const roles = new Map<string, { rolesRoot: string; roleId: string; files: Set<string>; referenced: boolean }>();
      const rootsToRead = new Set([path.resolve(input.rolesRoot)]);
      const keyFor = (root: string, roleId: string): string => JSON.stringify([root, roleId]);
      const put = (root: string, roleId: string, file = "persona.md", referenced = false): void => {
        const key = keyFor(root, roleId);
        const item = roles.get(key) ?? { rolesRoot: root, roleId, files: new Set<string>(), referenced: false };
        if (referenced) item.files.add(normalizePersonaFile(file));
        item.referenced ||= referenced;
        roles.set(key, item);
      };
      for (const definition of this.gateways.values()) {
        if (definition.agentRoleDeviceId) continue;
        const roleId = sanitizeRoleId(definition.agentRoleId);
        if (!roleId) continue;
        const configured = String(definition.rolesDir || "").trim();
        const root = configured ? path.resolve(input.rootDir, configured) : path.resolve(input.rolesRoot);
        rootsToRead.add(root);
        put(root, roleId, definition.agentRoleFile, true);
      }
      const enumerated = new Set<string>();
      await scope.run([...rootsToRead],
        root => create<string[]>({ kind: "directories", root }),
        (root, names) => {
          enumerated.add(root);
          for (const name of names) put(root, name);
        }, failed);
      for (const [key, persona] of this.personas) {
        if (!rootsToRead.has(persona.rolesRoot)
          || (enumerated.has(persona.rolesRoot) && !roles.has(key))) this.personas.delete(key);
      }
      await scope.run([...roles.entries()],
        ([_key, item]) => create<RouteCatalogPersonaPresentation>({
          kind: "persona", rolesRoot: item.rolesRoot, roleId: item.roleId, roleFiles: [...item.files]
        }),
        async ([key, item], persona) => {
          if (persona.isPersona || item.referenced) this.personas.set(key, persona);
          else this.personas.delete(key);
          await publish();
        }, failed);
      return snapshot(failures > 0);
    })();
    return { result, cancel: () => scope.cancel() };
  }
}

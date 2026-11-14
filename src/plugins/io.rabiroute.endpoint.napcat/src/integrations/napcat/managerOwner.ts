import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayListenerAccess } from "@rabiroute/plugin-sdk";
import { createNapcatWsEndpointAccess } from "./wsEndpointLease.js";
import { napcatListenerLocalName } from "@rabiroute/host-api/adapters/platformNativeOperations";
import { recoverNapcatExternalPorts, napcatExternalPortCandidate } from "./externalPortRecovery.js";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { definitionUsesNapcat as sharedDefinitionUsesNapcat, normalizeNapCatInstances as sharedNormalizeNapCatInstances, autoAssignGatewayPorts as sharedAutoAssignGatewayPorts, validateGatewayPortConflicts as sharedValidateGatewayPortConflicts, validateNapcatRouteCardinality, type GatewayDefinition, type NapCatInstanceDefinition, type LegacyMessageAdapterType as MessageAdapterType } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { GatewayRuntime } from "@rabiroute/host-api/manager/runtimeRegistry";
import { NapcatLifecycleOwner, validateNapcatBindings, type NapcatBinding } from "../../manager/napcatLifecycleOwner.js";
import { createNapcatProcessDriver } from "../../manager/napcatProcessDriver.js";
import { roleStorageOperationKey } from "@rabiroute/host-api/manager/roleStorageApplication";
import type { ScanDiagnostic } from "@rabiroute/host-api/manager/scanController";
import { scanNapcatHealthReadOnly, type NapcatHealthScanPayload } from "../../messageEndpoints/napcatHealthScan.js";
import { configureNapcatOneBot, launchNapcatInstance as launchNapcatInstanceEndpoint, launchNapcatProcess as launchManagedNapcatProcess, prepareManagedNapcatInstance, prepareNapcatExternalPortCandidate, verifyNapcatRecoveredAuthorization, resolveNapcatLaunchPlan, requestNapcatBotExit, scanNapcatEndpoint, stopNapcatInstance as stopNapcatInstanceEndpoint, testNapcatHealth as testNapcatHealthEndpoint, type NapcatLaunchPlan, type NapcatManagerContext, type NapcatLaunchRequest as ManagedNapcatLaunchRequest } from "../../messageEndpoints/napcatManager.js";
import type { NapcatAddRequest, NapcatRemoveRequest } from "../../manager/napcatControlRoutes.js";

export type NapcatManagerHostPorts = GatewayListenerAccess & {
  rootDir: string; managerPort: number; readOnly: boolean;
  readRuntimes(): Array<{ definition: GatewayDefinition; running: boolean; status: Record<string, unknown> }>;
  appendRouteLog(routeId: string, line: string): void;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
  normalizeDefinition(definition: GatewayDefinition): GatewayDefinition;
  readRoutes(): GatewayDefinition[];
  writeRoutes(routes: GatewayDefinition[], revision: string, operationId: string): Promise<unknown>;
  saveRoute(definition: GatewayDefinition): Promise<void>;
  routeVersion(): string;
  syncRoutes(): unknown;
  gatewayPayload(): unknown;
  log(event: string, detail: string): void;
};

/** The plugin owns platform protocols, configuration actions and exact managed process identities. */
export function createNapcatManagerOwner(host: NapcatManagerHostPorts, previous?: { resources: NapcatManagerResources }, signal = new AbortController().signal) {
  const { rootDir, managerPort, checkHttpEndpoint, normalizeDefinition } = host;
  const runtimes = { get: (id: string) => host.readRuntimes().find(runtime => runtime.definition.id === id), values: () => host.readRuntimes() };
  const appendLog = (runtime: { definition: GatewayDefinition }, line: string) => host.appendRouteLog(runtime.definition.id, line);
  const readConfig = () => ({ gateways: host.readRoutes() });
  const writeConfig = (config: {gateways: GatewayDefinition[]}, revision: string, operationId: string) => host.writeRoutes(config.gateways, revision, operationId);
  const routeCatalogVersion = () => ({ routeConfigHash: host.routeVersion() });
  const syncRunningGateways = () => host.syncRoutes();
  const standaloneGatewayPayload = () => host.gatewayPayload();
  const NAPCAT_HEALTH_SCAN_DEADLINE_MS = 6500;
  const resources: NapcatManagerResources = previous?.resources ?? {};
  const wsEndpoints = createNapcatWsEndpointAccess({ listeners: host, signal,
    timeoutMs: getTimeoutMs("napcat.gatewayListenerReady", 10000), assertBound: request => { napcatProcessOwner().assertBound(request); } });
  const napcatProcessOwner = () => resources.processOwner ??= new NapcatLifecycleOwner({
    statePath: path.join(rootDir, "data", ".runtime", "napcat-process-ownership.json"),
    driver: createNapcatProcessDriver(async binding => {
      const instance = sharedNormalizeNapCatInstances(runtimes.get(binding.gatewayId)?.definition ?? {id:binding.gatewayId} as GatewayDefinition).find(item => item.id === binding.instanceId && item.httpUrl === binding.httpUrl);
      if (instance) await requestNapcatBotExit(instance.httpUrl, instance.accessToken);
    }),
    log: host.log
  });
  async function writeAdapterConfigFile(definition: GatewayDefinition) {
    validateNapcatRouteCardinality(definition);
    validateNapcatBindings(routeNapcatBindings([...host.readRoutes().filter(item=>item.id!==definition.id),definition]));
    await host.saveRoute(definition);
  }
function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoreNapcatInstance(definition: GatewayDefinition, instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): void {
  const next = new Set(normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  definition.ignoredNapcatInstanceIds = [...next];
}

async function addManagedNapcatInstance(
  request: NapcatAddRequest,
  context: ReturnType<typeof napcatManagerCtx>
): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  if (!gatewayId) throw new Error("缺少 gatewayId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const definition = runtime.definition;
  if (definition.enabled === false || !sharedDefinitionUsesNapcat(definition)) throw new Error("NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
  const instances = sharedNormalizeNapCatInstances(definition);
  if (instances.length > 0) {
    throw new Error("每个 Route 只能绑定一个 NapCat；如需另一个 QQ，请新建 Route。");
  }
  const index = instances.length + 1;
  const id = `napcat-${randomUUID()}`;
  const used = new Set<number>();
  for (const runtimeItem of runtimes.values()) {
    for (const item of sharedNormalizeNapCatInstances(runtimeItem.definition)) {
      used.add(Number(item.gatewayPort || 0));
      try { used.add(Number(new URL(item.httpUrl).port || 0)); } catch { /* ignore */ }
      try { used.add(Number(new URL(item.webuiUrl || "").port || 0)); } catch { /* ignore */ }
    }
  }

  const steps = ["正在准备 NapCat 实例...", "正在查找合适端口..."];
  const webuiPort = await napcatExternalPortCandidate(used);
  const httpPort = await napcatExternalPortCandidate(used);
  const wsPort = 0;
  steps.push(`已分配端口：WebUI ${webuiPort} / HTTP ${httpPort} / WS ${wsPort}`);

  const prepared = prepareManagedNapcatInstance(context, {
    id,
    name: `QQ ${index}`,
    gatewayPort: wsPort,
    httpPort,
    webuiPort,
    index
  });
  const instance = prepared.instance;
  steps.push(...prepared.steps);

  definition.napcatInstances = [instance];
  const primary = definition.napcatInstances.find((item) => item.enabled !== false) ?? instance;
  definition.gatewayPort = primary.gatewayPort;
  definition.napcatHttpUrl = primary.httpUrl;
  definition.napcatWebuiUrl = primary.webuiUrl;
  definition.napcatAccessToken = primary.accessToken ?? "";
  definition.napcatWebuiToken = primary.webuiToken ?? "";
  await writeAdapterConfigFile(definition);

  steps.push("正在执行启动命令...");
  const launchResult = await launchNapcatInstanceEndpoint(context, { gatewayId, instanceId: id });
  steps.push(String(launchResult.message || "已尝试启动 NapCat 后台。"));
  return {
    ok: launchResult.ok !== false,
    message: launchResult.ok !== false
      ? "已创建并启动 NapCat；请在当前 Route 的 NapCat 卡片中完成 QQ 登录。"
      : "已创建 NapCat，但后台未在超时时间内可达；请检查启动命令后从当前 Route 卡片重试。",
    steps,
    launch: launchResult,
    instance,
    webuiUrl: instance.webuiUrl
  };
}

async function removeManagedNapcatInstance(request: NapcatRemoveRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少 gatewayId 或 instanceId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const instances = sharedNormalizeNapCatInstances(runtime.definition);
  const existing = instances.find((item) => item.id === instanceId);
  if (!existing) throw new Error("NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
  const stop = await stopNapcatInstanceEndpoint(napcatManagerCtx(), {
    gatewayId,
    instanceId,
    name: request.name,
    gatewayPort: request.gatewayPort,
    httpUrl: request.httpUrl,
    webuiUrl: request.webuiUrl,
    accessToken: request.accessToken,
    webuiToken: request.webuiToken,
    launchCommand: request.launchCommand,
    workingDir: request.workingDir
  });
  if (stop.ok !== true) {
    return {
      ok: false,
      message: "NapCat 后台仍在运行，已保留实例配置和插件进程所有权。",
      stop
    };
  }

  ignoreNapcatInstance(runtime.definition, {
    ...(existing || {}),
    id: instanceId,
    gatewayPort: request.gatewayPort ?? existing?.gatewayPort,
    httpUrl: request.httpUrl ?? existing?.httpUrl,
    webuiUrl: request.webuiUrl ?? existing?.webuiUrl,
    botUserId: existing?.botUserId
  });
  runtime.definition.napcatInstances = instances.filter((item) => item.id !== instanceId);
  const primary = runtime.definition.napcatInstances.find((item) => item.enabled !== false);
  if (primary) {
    runtime.definition.gatewayPort = primary.gatewayPort;
    runtime.definition.napcatHttpUrl = primary.httpUrl;
    runtime.definition.napcatWebuiUrl = primary.webuiUrl;
    runtime.definition.napcatAccessToken = primary.accessToken ?? "";
    runtime.definition.napcatWebuiToken = primary.webuiToken ?? "";
  } else {
    runtime.definition.messageAdaptersDisabled = [...new Set([...(runtime.definition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
    runtime.definition.messageAdapterPolicies = {
      ...(runtime.definition.messageAdapterPolicies ?? {}),
      napcat: {
        ...(runtime.definition.messageAdapterPolicies?.napcat ?? {}),
        inputEnabled: false
      }
    };
    runtime.definition.napcatAccessToken = "";
    runtime.definition.napcatWebuiToken = "";
  }
  await writeAdapterConfigFile(runtime.definition);
  return {
    ok: true,
    message: "已停止并移除 NapCat 实例。",
    stop
  };
}

function routeNapcatBindings(definitions: GatewayDefinition[]): NapcatBinding[] {
  return definitions
    .filter(definition => definition.enabled !== false && sharedDefinitionUsesNapcat(definition))
    .flatMap(definition => sharedNormalizeNapCatInstances(definition).filter(instance => instance.enabled !== false).map(instance => ({
      gatewayId: definition.id, instanceId: instance.id, botUserId: String(instance.botUserId || "").trim() || undefined,
      workingDir: instance.workingDir ? path.resolve(rootDir, instance.workingDir) : undefined,
      httpUrl: instance.httpUrl, webuiUrl: instance.webuiUrl
    })));
}

function napcatManagerCtx(beforeLaunch?: () => void) {
  const bindingScope = new AsyncLocalStorage<string>();
  const context: NapcatManagerContext = {
    rootDir,
    getRuntimes: () => [...runtimes.values()].map(runtime => {
      const instances = sharedNormalizeNapCatInstances(runtime.definition).map(instance => {
        const descriptor = wsEndpoints.read(runtime.definition.id, instance.id);
        const recovered = napcatProcessOwner().recoveredEndpoints({ gatewayId: runtime.definition.id, instanceId: instance.id });
        return { ...instance, ...(descriptor ? { gatewayPort: descriptor.address.port } : {}),
          ...(recovered ? { httpUrl: recovered.httpUrl, webuiUrl: recovered.webuiUrl } : {}) };
      });
      return { ...runtime, definition: { ...runtime.definition, napcatInstances: instances,
        gatewayPort: instances.find(instance => instance.enabled !== false)?.gatewayPort ?? runtime.definition.gatewayPort }, process: runtime.running || undefined };
    }),
    normalizeNapCatInstances: sharedNormalizeNapCatInstances,
    appendLog,
    checkHttpEndpoint,
    runBindingOperation: async <T>(request: ManagedNapcatLaunchRequest, operation: () => Promise<T>) => {
      const key = JSON.stringify([request.gatewayId, request.instanceId]);
      const nested = bindingScope.getStore() === key;
      const result = await bindingScope.run(key, () => napcatProcessOwner().run(request, () => wsEndpoints.run(request, operation)));
      if (!nested) await commitRecoveredEndpoints(request);
      return result;
    },
    recoverExternalPorts: async (request: ManagedNapcatLaunchRequest, instance: Parameters<NonNullable<NapcatManagerContext["recoverExternalPorts"]>>[1],
      plan: NapcatLaunchPlan, launch: (instance: Parameters<NonNullable<NapcatManagerContext["recoverExternalPorts"]>>[1]) => Promise<Record<string, unknown>>) => {
      const proof = wsEndpoints.read(request.gatewayId!, request.instanceId!);
      if (!proof) throw new Error("No original NapCat listener for external port recovery.");
      const assertCurrent = () => { beforeLaunch?.(); proof.assertCurrent(); napcatProcessOwner().assertBound(request); signal.throwIfAborted(); };
      return recoverNapcatExternalPorts({ instance, assertCurrent,
        stopped: () => napcatProcessOwner().confirmPortRecoveryStopped(request, plan),
        writeCandidate: candidate => prepareNapcatExternalPortCandidate(candidate, assertCurrent), launch,
        conflicted: candidate => napcatProcessOwner().hasForeignPortConflict(request, plan, { httpUrl: candidate.httpUrl, webuiUrl: candidate.webuiUrl! }),
        verify: async candidate => {
          const deadline = Date.now() + getTimeoutMs("napcat.externalPorts.ownerReady", 15000);
          do {
            assertCurrent();
            await napcatProcessOwner().recordLaunch(request);
            const owned = await napcatProcessOwner().verifyRecoveredPorts(request, plan, { httpUrl: candidate.httpUrl, webuiUrl: candidate.webuiUrl! });
            assertCurrent();
            if (owned) return await verifyNapcatRecoveredAuthorization(context, candidate, owned.httpReady) ? owned : undefined;
            if (await napcatProcessOwner().hasForeignPortConflict(request, plan, { httpUrl: candidate.httpUrl, webuiUrl: candidate.webuiUrl! })) return;
            assertCurrent();
            await new Promise(resolve => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          return;
        },
        stopOwned: async () => {
          if (!await napcatProcessOwner().confirmPortRecoveryStopped(request, plan)) await napcatProcessOwner().stopForRestart(request);
        },
        publish: candidate => { assertCurrent(); napcatProcessOwner().recordRecoveredEndpoints(request,
          { httpUrl: candidate.httpUrl, webuiUrl: candidate.webuiUrl! }); }
      });
    },
    assertWsEndpointCurrent: () => { beforeLaunch?.(); wsEndpoints.assertCurrent(); },
    stopOwnedInstance: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner().remove(request),
    stopOwnedInstanceForRestart: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner().stopForRestart(request),
    launchNapcatProcess: async (plan: NapcatLaunchPlan, visible: boolean, request: ManagedNapcatLaunchRequest) => {
      beforeLaunch?.();
      wsEndpoints.assertCurrent();
      return await napcatProcessOwner().launch(request, () => { wsEndpoints.assertCurrent(); return launchManagedNapcatProcess(plan, visible); }, plan);
    },
    recordNapcatLaunchPids: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner().recordLaunch(request)
  };
  async function commitRecoveredEndpoints(request: ManagedNapcatLaunchRequest) {
    const receipt = napcatProcessOwner().recoveredEndpoints(request);
    if (!receipt) return;
    await napcatProcessOwner().run(request, async () => {
      const route = host.readRoutes().find(value => value.id === request.gatewayId);
      const original = route && sharedNormalizeNapCatInstances(route).find(value => value.id === request.instanceId);
      if (!route || !original) throw new Error("NapCat route changed before recovered endpoint commit.");
      if (original.httpUrl === receipt.httpUrl && original.webuiUrl === receipt.webuiUrl) {
        napcatProcessOwner().acknowledgeRecoveredEndpoints(request); return;
      }
      if (original.httpUrl !== receipt.previousHttpUrl || original.webuiUrl !== receipt.previousWebuiUrl)
        throw new Error("NapCat endpoint configuration changed before recovered endpoint commit.");
      const descriptor = host.readListener(route.id, napcatListenerLocalName(original.id));
      if (!descriptor) throw new Error("No current Gateway generation for recovered endpoint commit.");
      const candidate = { ...original, httpUrl: receipt.httpUrl, webuiUrl: receipt.webuiUrl, gatewayPort: descriptor.address.port };
      const owned = await napcatProcessOwner().verifyRecoveredPorts(request, resolveNapcatLaunchPlan(candidate, rootDir), receipt);
      if (!owned || !await verifyNapcatRecoveredAuthorization(context, candidate, owned.httpReady)) throw new Error("Recovered NapCat endpoint proof expired before commit.");
      descriptor.assertCurrent(); beforeLaunch?.(); signal.throwIfAborted();
      const next = structuredClone(route);
      next.napcatInstances = sharedNormalizeNapCatInstances(route).map(value => value.id === original.id
        ? { ...value, httpUrl: receipt.httpUrl, webuiUrl: receipt.webuiUrl } : value);
      const primary = next.napcatInstances.find(value => value.enabled !== false);
      if (primary?.id === original.id) { next.napcatHttpUrl = receipt.httpUrl; next.napcatWebuiUrl = receipt.webuiUrl; }
      // This intentional route commit may replace Gateway's WS generation. The original WS operation already drained.
      await writeAdapterConfigFile(next);
      napcatProcessOwner().acknowledgeRecoveredEndpoints(request);
    });
  }
  return context;
}

async function repairGatewayConfigsForScan(
  _targetGatewayId?: string
): Promise<{ changed: boolean; messages: string[] }> {
  const original = readConfig().gateways;
  const messages: string[] = [];
  const managedNapcatRoot = path.resolve(rootDir, "data", "napcat");
  const normalized = original.map((definition) => {
    if (!sharedDefinitionUsesNapcat(definition) && Array.isArray(definition.napcatInstances) && definition.napcatInstances.length > 0) {
      messages.push(`已移除 ${definition.id} 中残留的 NapCat 实例配置。`);
    }
    const cleanedDefinition = { ...definition };
    if (Array.isArray(cleanedDefinition.napcatInstances)) {
      const kept = cleanedDefinition.napcatInstances.filter((instance) => {
        const workingDir = instance.workingDir?.trim();
        if (!workingDir) return true;
        const resolved = path.resolve(workingDir);
        const relative = path.relative(managedNapcatRoot, resolved);
        const isManaged = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        const keep = !isManaged || fs.existsSync(resolved);
        if (!keep) {
          messages.push(`已移除 ${definition.id}/${instance.id} 中已删除的 NapCat 实例配置。`);
        }
        return keep;
      });
      cleanedDefinition.napcatInstances = kept;
      if ((definition.napcatInstances?.length ?? 0) > 0 && kept.length === 0) {
        cleanedDefinition.messageAdaptersDisabled = [...new Set([...(cleanedDefinition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
        cleanedDefinition.messageAdapterPolicies = {
          ...(cleanedDefinition.messageAdapterPolicies ?? {}),
          napcat: {
            ...(cleanedDefinition.messageAdapterPolicies?.napcat ?? {}),
            inputEnabled: false
          }
        };
      }
    }
    return normalizeDefinition(cleanedDefinition);
  });
  sharedAutoAssignGatewayPorts(normalized, managerPort);
  sharedValidateGatewayPortConflicts(normalized);

  const byId = new Map(original.map((definition) => [definition.id, definition]));
  for (const repaired of normalized) {
    const before = byId.get(repaired.id);
    if (!before) {
      messages.push(`已补齐路由 ${repaired.id} 的标准配置。`);
      continue;
    }
    if (before.gatewayPort !== repaired.gatewayPort) {
      messages.push(`已为 ${repaired.id} 重新分配入口端口：${before.gatewayPort} -> ${repaired.gatewayPort}。`);
    }
    if (before.webhookPort !== repaired.webhookPort && repaired.webhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 Webhook 端口：${before.webhookPort || "-"} -> ${repaired.webhookPort}。`);
    }
    if (before.xiaoaiWebhookPort !== repaired.xiaoaiWebhookPort && repaired.xiaoaiWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 XiaoAI 端口：${before.xiaoaiWebhookPort || "-"} -> ${repaired.xiaoaiWebhookPort}。`);
    }
    if (sharedDefinitionUsesNapcat(repaired)) {
      const beforeInstances = before.napcatInstances ?? [];
      const repairedInstances = repaired.napcatInstances ?? [];
      for (const instance of repairedInstances) {
        const old = beforeInstances.find((item) => item.id === instance.id);
        if (!old) continue;
        if (old.gatewayPort !== instance.gatewayPort) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 WS 端口：${old.gatewayPort} -> ${instance.gatewayPort}。`);
        }
        if (old.httpUrl !== instance.httpUrl) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 HTTP 地址：${old.httpUrl || "-"} -> ${instance.httpUrl}。`);
        }
      }
    }
  }

  const changed = messages.length > 0;
  if (changed) {
    const observedRevision = routeCatalogVersion().routeConfigHash;
    await writeConfig(
      { gateways: normalized },
      observedRevision,
      roleStorageOperationKey("route-scan-repair", observedRevision, messages.join("\n"))
    );
    syncRunningGateways();
  }
  return { changed, messages };
}

async function repairAllNapcatInstances(): Promise<Record<string, unknown>> {
  const scanRepair = await repairGatewayConfigsForScan();
  const context = napcatManagerCtx();
  const results: Array<Record<string, unknown>> = [];
  for (const runtime of runtimes.values()) {
    if (!sharedDefinitionUsesNapcat(runtime.definition)) continue;
    for (const instance of runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)) {
      const health = await testNapcatHealthEndpoint(context, {
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort
      });
      if (health.fixAvailable) {
        try {
          const fixed = await configureNapcatOneBot(context, {
            httpUrl: instance.httpUrl,
            webuiUrl: instance.webuiUrl,
            accessToken: instance.accessToken,
            webuiToken: instance.webuiToken,
            gatewayPort: instance.gatewayPort
          });
          results.push({
            gatewayId: runtime.definition.id,
            instanceId: instance.id,
            ok: true,
            action: "configure-onebot",
            ...fixed
          });
        } catch (error) {
          results.push({
            gatewayId: runtime.definition.id,
            instanceId: instance.id,
            ok: false,
            action: "configure-onebot",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        results.push({
          gatewayId: runtime.definition.id,
          instanceId: instance.id,
          ok: Boolean(health.ok),
          action: "health-check",
          message: health.ok ? "已连通，无需修复。" : String(health.message || "没有可自动修复项。")
        });
      }
    }
  }
  return {
    ok: true,
    repair: scanRepair,
    results,
    napcatHealth: (await napcatScanHealthPayload()).payload,
    gatewayPayload: standaloneGatewayPayload()
  };
}

async function napcatScanHealthPayload(
  trackProbe: <T>(probe: Promise<T>) => Promise<T> = probe => probe
): Promise<{
  payload: NapcatHealthScanPayload;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
}> {
  const ctx = napcatManagerCtx();
  const napcatRuntimes = [...runtimes.values()].filter((runtime) => sharedDefinitionUsesNapcat(runtime.definition));
  return scanNapcatHealthReadOnly({
    runtimes: napcatRuntimes,
    gatewayId: (runtime) => runtime.definition.id,
    instances: (runtime) => runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition),
    instanceId: (instance) => instance.id,
    instanceEnabled: (instance) => instance.enabled !== false,
    instanceMetadata: (instance) => ({
      gatewayPort: instance.gatewayPort,
      instanceName: instance.name || instance.id,
      webui: {
        url: instance.webuiUrl,
        configuredUrl: instance.webuiUrl
      }
    }),
    testHealth: (runtime, instance) => trackProbe(testNapcatHealthEndpoint(ctx, {
        gatewayId: runtime.definition.id,
        instanceId: instance.id,
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort,
        botUserId: (instance as NapCatInstanceDefinition & { botUserId?: string | number }).botUserId,
        botNickname: (instance as NapCatInstanceDefinition & { botNickname?: string }).botNickname,
        readWebuiLoginInfo: true,
        inspectProcesses: false
      }) as Promise<Record<string, unknown>>)
  }, { deadlineMs: getTimeoutMs("backend.manager.controlPlaneRoutes.NAPCAT_HEALTH_SCAN_DEADLINE_MS", NAPCAT_HEALTH_SCAN_DEADLINE_MS) });
}
  return Object.freeze({
    resources,
    async stopResources() { await resources.processOwner?.shutdown(); },
    context: napcatManagerCtx, add: addManagedNapcatInstance, remove: removeManagedNapcatInstance, repair: repairAllNapcatInstances,
    scanHealth: napcatScanHealthPayload, scan: () => scanNapcatEndpoint(napcatManagerCtx()),
    configurationKey(routes: readonly GatewayDefinition[]) {
      return JSON.stringify(routes.filter(route => sharedDefinitionUsesNapcat(route) || (route.napcatInstances?.length ?? 0) > 0).map(route => ({
        id: route.id, enabled: route.enabled, messageInputsDisabled: route.messageInputsDisabled,
        selected: sharedDefinitionUsesNapcat(route), gatewayPort: route.gatewayPort,
        instances: route.napcatInstances, httpUrl: route.napcatHttpUrl, webuiUrl: route.napcatWebuiUrl,
        accessToken: route.napcatAccessToken, webuiToken: route.napcatWebuiToken
      })).sort((a, b) => a.id.localeCompare(b.id)));
    },
    validateRoutes(routes: readonly GatewayDefinition[]) { routes.forEach(validateNapcatRouteCardinality); validateNapcatBindings(routeNapcatBindings([...routes])); },
    async reconcileRoutes(routes: readonly GatewayDefinition[]) { if (!host.readOnly) await napcatProcessOwner().reconcile(routeNapcatBindings([...routes])); }
  });
}

export type NapcatManagerResources = { processOwner?: NapcatLifecycleOwner };

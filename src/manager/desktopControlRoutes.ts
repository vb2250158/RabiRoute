import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type http from "node:http";
import { roleFilePath } from "../shared/routePaths.js";
import { routeRuntimeParts, sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
import { handleDesktopLifecycleApi } from "./desktopLifecycleRoutes.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";


export type DesktopConfigFileRoute = {
  id: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
};

export type DesktopConfigFileContext = {
  routeRoot: string;
  rolesRoot: string;
  ensureDataDirs: () => void;
  findRoute: (gatewayId: string) => DesktopConfigFileRoute | undefined;
  ensurePersonaConfigFile: (roleId: string) => string;
  adapterConfigPath: (configName: string) => string;
  writeAdapterConfigFile: (route: DesktopConfigFileRoute) => void;
};

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "explorer", target] : [target];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function desktopConfigFilePayload(
  type: string | null,
  gatewayId: string | null,
  roleId: string | null,
  context: DesktopConfigFileContext
): Record<string, unknown> {
  if (type === "manager") {
    context.ensureDataDirs();
    openFileWithDefaultApp(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const route = gatewayId ? context.findRoute(gatewayId) : undefined;
  if (type === "role" || type === "persona") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开 persona.md。");
    const rolePath = roleFilePath(context.rolesRoot, safeRoleId, route?.agentRoleFile ?? "persona.md");
    if (!fs.existsSync(rolePath)) {
      fs.mkdirSync(path.dirname(rolePath), { recursive: true });
      fs.writeFileSync(rolePath, "", "utf8");
    }
    openFileWithDefaultApp(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-folder") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开人格文件夹。");
    const roleDirectory = path.join(context.rolesRoot, safeRoleId);
    fs.mkdirSync(roleDirectory, { recursive: true });
    openFileWithDefaultApp(roleDirectory);
    return { code: 0, data: { path: roleDirectory } };
  }

  if (type === "role-message-config") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开 personaConfig.json。");
    const configPath = context.ensurePersonaConfigFile(safeRoleId);
    openFileWithDefaultApp(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }
  if (!gatewayId || !route) {
    openFileWithDefaultApp(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const configName = sanitizeConfigName(route.configName) || routeRuntimeParts(route.id).configName;
  const configPath = context.adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) context.writeAdapterConfigFile(route);
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openFileWithDefaultApp(targetPath);
  return { code: 0, data: { path: targetPath } };
}

export type DesktopControlRoutesContext = {
  openConfigFilePayload: (
    type: string | null,
    gatewayId: string | null,
    roleId: string | null
  ) => Record<string, unknown>;
  rootDir: string;
  shutdownManager: (reason: string) => void | Promise<void>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  scheduleShutdown?: (task: () => void, delayMs: number) => void;
  settingsHandler?: ManagerPluginRouteHandler;
};

export type DesktopControlRoutes = {
  handler: ManagerPluginRouteHandler;
  stopAcceptingAndDrain: () => Promise<void>;
  activeRequestCount: () => number;
};

type DesktopControlRuntimeHooks = {
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

function handleDesktopControlApiWithRuntime(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: DesktopControlRoutesContext,
  hooks: DesktopControlRuntimeHooks
): boolean {
  if (context.settingsHandler?.(request, requestUrl, response)) return true;

  if (request.method === "POST" && requestUrl.pathname === "/open-config-file") {
    context.jsonResponse(response, 200, context.openConfigFilePayload(
      requestUrl.searchParams.get("type"),
      requestUrl.searchParams.get("gatewayId"),
      requestUrl.searchParams.get("roleId")
    ));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/manager/start") {
    context.jsonResponse(response, 200, { code: 0, message: "manager is already running" });
    return true;
  }

  return handleDesktopLifecycleApi(request, requestUrl, response, {
    rootDir: context.rootDir,
    shutdownManager: context.shutdownManager,
    scheduleShutdown: context.scheduleShutdown,
    trackOperation: hooks.trackOperation
  });
}

export function handleDesktopControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: DesktopControlRoutesContext
): boolean {
  return handleDesktopControlApiWithRuntime(request, requestUrl, response, context, {});
}

/**
 * Creates one activation-scoped Desktop control route handler. During plugin
 * disposal, unregister `handler` first, then await `stopAcceptingAndDrain()`.
 */
export function createDesktopControlRoutes(
  context: DesktopControlRoutesContext
): DesktopControlRoutes {
  const requestTracker = new ManagerPluginRequestTracker();
  const shutdownTimers = new Set<NodeJS.Timeout>();
  let acceptingShutdownSchedules = true;
  const routeContext: DesktopControlRoutesContext = {
    ...context,
    shutdownManager: (reason) => requestTracker.trackOperation(
      Promise.resolve().then(() => context.shutdownManager(reason))
    ),
    scheduleShutdown: (task, delayMs) => {
      if (!acceptingShutdownSchedules) return;
      const timer = setTimeout(() => {
        shutdownTimers.delete(timer);
        if (!acceptingShutdownSchedules) return;
        task();
      }, delayMs);
      shutdownTimers.add(timer);
    }
  };
  const runtimeHooks: DesktopControlRuntimeHooks = {
    trackOperation: operation => requestTracker.trackOperation(operation)
  };
  return {
    handler: requestTracker.wrap((request, requestUrl, response) => (
      handleDesktopControlApiWithRuntime(request, requestUrl, response, routeContext, runtimeHooks)
    )),
    stopAcceptingAndDrain: async () => {
      const draining = requestTracker.stop();
      acceptingShutdownSchedules = false;
      for (const timer of shutdownTimers) clearTimeout(timer);
      shutdownTimers.clear();
      await draining;
    },
    activeRequestCount: () => requestTracker.activeCount()
  };
}

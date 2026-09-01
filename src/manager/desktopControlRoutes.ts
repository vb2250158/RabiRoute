import path from "node:path";
import { spawn } from "node:child_process";
import type http from "node:http";
import { routeRuntimeParts, sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
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
  ensureDataDirs: () => Promise<void>;
  findRoute: (gatewayId: string) => DesktopConfigFileRoute | undefined;
  ensurePersonaConfigFile: (roleId: string) => Promise<string>;
  ensureRoleFile: (roleId: string, roleFile: string) => Promise<string>;
  ensureRoleFolder: (roleId: string) => Promise<string>;
  adapterConfigPath: (configName: string) => string;
  writeAdapterConfigFile: (route: DesktopConfigFileRoute) => Promise<void>;
  openPath?: (target: string) => void;
};

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "explorer", target] : [target];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function desktopConfigFilePayload(
  type: string | null,
  gatewayId: string | null,
  roleId: string | null,
  context: DesktopConfigFileContext
): Promise<Record<string, unknown>> {
  const openPath = context.openPath ?? openFileWithDefaultApp;
  if (type === "manager") {
    await context.ensureDataDirs();
    openPath(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const route = gatewayId ? context.findRoute(gatewayId) : undefined;
  if (type === "role" || type === "persona") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开 persona.md。");
    const rolePath = await context.ensureRoleFile(
      safeRoleId,
      route?.agentRoleFile ?? "persona.md"
    );
    openPath(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-folder") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开人格文件夹。");
    const roleDirectory = await context.ensureRoleFolder(safeRoleId);
    openPath(roleDirectory);
    return { code: 0, data: { path: roleDirectory } };
  }

  if (type === "role-message-config") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由人格，再打开 personaConfig.json。");
    const configPath = await context.ensurePersonaConfigFile(safeRoleId);
    openPath(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }
  if (!gatewayId || !route) {
    await context.ensureDataDirs();
    openPath(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const configName = sanitizeConfigName(route.configName) || routeRuntimeParts(route.id).configName;
  const configPath = context.adapterConfigPath(configName);
  await context.writeAdapterConfigFile(route);
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openPath(targetPath);
  return { code: 0, data: { path: targetPath } };
}

export type DesktopControlRoutesContext = {
  openConfigFilePayload: (
    type: string | null,
    gatewayId: string | null,
    roleId: string | null
  ) => Promise<Record<string, unknown>>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
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
    const operation = context.openConfigFilePayload(
      requestUrl.searchParams.get("type"),
      requestUrl.searchParams.get("gatewayId"),
      requestUrl.searchParams.get("roleId")
    ).then(payload => {
      context.jsonResponse(response, 200, payload);
    }).catch(error => {
      const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode);
      const code = typeof (error as { code?: unknown } | null)?.code === "string"
        ? String((error as { code: string }).code)
        : "request_failed";
      context.jsonResponse(
        response,
        Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 400,
        {
          code: -1,
          errorCode: code,
          message: error instanceof Error ? error.message : "Desktop config request failed."
        }
      );
    });
    void (hooks.trackOperation?.(operation) ?? operation).catch(() => undefined);
    return true;
  }

  return false;
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
  const runtimeHooks: DesktopControlRuntimeHooks = {
    trackOperation: operation => requestTracker.trackOperation(operation)
  };
  return {
    handler: requestTracker.wrap((request, requestUrl, response) => (
      handleDesktopControlApiWithRuntime(request, requestUrl, response, context, runtimeHooks)
    )),
    stopAcceptingAndDrain: async () => {
      const draining = requestTracker.stop();
      await draining;
    },
    activeRequestCount: () => requestTracker.activeCount()
  };
}

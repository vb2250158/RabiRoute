import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentManagerApiContext } from "../agentAdapters/managerApi.js";
import { scanAgentAdapters } from "../agentAdapters/managerApi.js";
import type { GatewayDefinition, GatewayConfigFile } from "../shared/gatewayConfigModel.js";
import { sanitizeConfigName } from "../shared/routeIdentity.js";
import { routeFolderPath } from "../shared/routePaths.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type RabiApiContext = {
  rootDir: string;
  routeRoot: string;
  managerPort: number;
  managerHost: string;
  version: () => string;
  globalConfig: RabiGlobalConfigStore;
  runtimes: () => Iterable<GatewayRuntime>;
  runtimeStatus: (runtime: GatewayRuntime) => Record<string, unknown>;
  readConfig: () => GatewayConfigFile;
  writeConfig: (config: GatewayConfigFile) => GatewayConfigFile;
  loadRuntimes: () => void;
  syncRunningGateways: () => void;
  agentManagerApiCtx: () => AgentManagerApiContext;
};

type RabiInstance = {
  guid: string;
  name: string;
  computerName: string;
  deviceType: string;
  baseUrl: string;
  host: string;
  port: number;
  version?: string;
  addresses?: string[];
  self?: boolean;
};

type AgentBindingPatch = {
  agentAdapter?: string;
  codexCwd?: string;
  codexThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function localIpv4Addresses(): string[] {
  const result: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal) result.push(item.address);
    }
  }
  return [...new Set(result)];
}

function hostFromRequest(request: http.IncomingMessage, fallbackPort: number): { host: string; port: number; baseUrl: string } {
  const hostHeader = String(request.headers.host || `127.0.0.1:${fallbackPort}`);
  const rawHost = hostHeader.replace(/^\[/, "").replace(/\]$/, "");
  const [hostPart, portPart] = rawHost.split(":");
  const host = hostPart || "127.0.0.1";
  const port = Number(portPart || fallbackPort) || fallbackPort;
  return { host, port, baseUrl: `http://${host}:${port}` };
}

function identityPayload(ctx: RabiApiContext, request: http.IncomingMessage): { code: number; data: RabiInstance & Record<string, unknown> } {
  const config = ctx.globalConfig.read();
  const fromRequest = hostFromRequest(request, ctx.managerPort);
  const publicHost = fromRequest.host === "127.0.0.1" || fromRequest.host === "localhost"
    ? localIpv4Addresses()[0] || fromRequest.host
    : fromRequest.host;
  const port = fromRequest.port || ctx.managerPort;
  return {
    code: 0,
    data: {
      guid: config.rabiGuid,
      name: config.rabiName,
      computerName: os.hostname(),
      deviceType: "RabiRoute Manager",
      host: publicHost,
      port,
      baseUrl: `http://${publicHost}:${port}`,
      version: ctx.version(),
      addresses: localIpv4Addresses(),
      managerHost: ctx.managerHost,
      configPath: ctx.globalConfig.configPath,
      self: true
    }
  };
}

function routeSummary(runtime: GatewayRuntime, runtimeStatus: Record<string, unknown>): Record<string, unknown> {
  const definition = runtime.definition;
  return {
    id: definition.id,
    name: definition.name,
    configName: sanitizeConfigName(definition.configName) || definition.id,
    routeName: definition.routeName,
    enabled: definition.enabled !== false,
    running: Boolean(runtime.process),
    agentAdapters: definition.agentAdapters ?? ["codex"],
    codexCwd: definition.codexCwd ?? "",
    codexThreadName: definition.codexThreadName ?? "",
    copilotCwd: definition.copilotCwd ?? "",
    copilotCliBin: definition.copilotCliBin ?? "",
    marvisAppId: definition.marvisAppId ?? "",
    astrbotUrl: definition.astrbotUrl ?? "",
    astrbotProjectId: definition.astrbotProjectId ?? "",
    astrbotSessionId: definition.astrbotSessionId ?? "",
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    agentRoleId: definition.agentRoleId ?? "",
    runtimeStatus
  };
}

function localRoutes(ctx: RabiApiContext): Record<string, unknown> {
  const routes = [...ctx.runtimes()].map((runtime) => routeSummary(runtime, ctx.runtimeStatus(runtime)));
  return { code: 0, data: { routes } };
}

function findGateway(config: GatewayConfigFile, routeId: string): GatewayDefinition | undefined {
  return config.gateways.find((gateway) => gateway.id === routeId || sanitizeConfigName(gateway.configName) === routeId);
}

function routeOptionsFromAgentScan(route: GatewayDefinition, scan: Record<string, any>): Record<string, unknown> {
  const agents = scan.agents ?? {};
  const activeAdapters = Array.isArray(route.agentAdapters) && route.agentAdapters.length ? route.agentAdapters : ["codex"];
  return {
    route: {
      id: route.id,
      name: route.name,
      configName: sanitizeConfigName(route.configName) || route.id,
      routeName: route.routeName,
      agentAdapters: activeAdapters,
      codexCwd: route.codexCwd ?? "",
      codexThreadName: route.codexThreadName ?? "",
      copilotCwd: route.copilotCwd ?? "",
      astrbotProjectId: route.astrbotProjectId ?? "",
      astrbotSessionId: route.astrbotSessionId ?? ""
    },
    cwdOptions: scan.cwdOptions ?? [],
    threadNames: scan.threadNames ?? [],
    agents: activeAdapters.reduce((result: Record<string, unknown>, adapter) => {
      result[adapter] = agents[adapter] ?? null;
      return result;
    }, {}),
    allAgents: agents
  };
}

async function localAgentOptions(ctx: RabiApiContext, routeId: string): Promise<Record<string, unknown>> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  const scan = await scanAgentAdapters(ctx.agentManagerApiCtx()) as Record<string, any>;
  return { code: 0, data: routeOptionsFromAgentScan(route, scan) };
}

function readJsonlTail(filePath: string, limit: number, afterId: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const afterIndex = afterId ? rows.findIndex((item) => String(item.id ?? "") === afterId) : -1;
  const selected = afterIndex >= 0 ? rows.slice(afterIndex + 1) : rows.slice(-limit);
  return selected.slice(-limit);
}

function localRabiLinkReplies(ctx: RabiApiContext, routeId: string, requestUrl: URL): Record<string, unknown> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  const configName = sanitizeConfigName(route.configName) || route.id;
  const limit = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get("limit") || 20) || 20));
  const afterId = String(requestUrl.searchParams.get("afterId") || "");
  const filePath = path.join(routeFolderPath(ctx.routeRoot, configName), "rabilink-replies.jsonl");
  return {
    code: 0,
    data: {
      route: {
        id: route.id,
        name: route.name,
        configName,
        routeName: route.routeName
      },
      file: path.relative(ctx.rootDir, filePath).replace(/\\/g, "/"),
      replies: readJsonlTail(filePath, limit, afterId)
    }
  };
}

function setLocalAgentBinding(ctx: RabiApiContext, routeId: string, patch: AgentBindingPatch): Record<string, unknown> {
  const config = ctx.readConfig();
  const route = findGateway(config, routeId);
  if (!route) return { code: -1, message: `Route not found: ${routeId}` };
  if (patch.agentAdapter) {
    if (patch.agentAdapter !== "codex" && patch.agentAdapter !== "copilotCli" && patch.agentAdapter !== "marvis" && patch.agentAdapter !== "astrbot") {
      return { code: -1, message: `Unsupported agent adapter: ${patch.agentAdapter}` };
    }
    route.agentAdapters = [patch.agentAdapter];
  }
  if (patch.codexCwd !== undefined) route.codexCwd = String(patch.codexCwd || "");
  if (patch.codexThreadName !== undefined) route.codexThreadName = String(patch.codexThreadName || "");
  if (patch.copilotCwd !== undefined) route.copilotCwd = String(patch.copilotCwd || "");
  if (patch.copilotCliBin !== undefined) route.copilotCliBin = String(patch.copilotCliBin || "");
  if (patch.marvisAppId !== undefined) route.marvisAppId = String(patch.marvisAppId || "");
  if (patch.astrbotUrl !== undefined) route.astrbotUrl = String(patch.astrbotUrl || "");
  if (patch.astrbotUsername !== undefined) route.astrbotUsername = String(patch.astrbotUsername || "");
  if (patch.astrbotPassword !== undefined) route.astrbotPassword = String(patch.astrbotPassword || "");
  if (patch.astrbotProjectId !== undefined) route.astrbotProjectId = String(patch.astrbotProjectId || "");
  if (patch.astrbotSessionId !== undefined) route.astrbotSessionId = String(patch.astrbotSessionId || "");
  const normalized = ctx.writeConfig(config);
  ctx.loadRuntimes();
  ctx.syncRunningGateways();
  const updated = findGateway(normalized, routeId) ?? route;
  return { code: 0, data: { route: updated } };
}

function parsePorts(value: string | null, fallback: number): number[] {
  const ports = (value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 65535);
  return [...new Set([fallback, 8790, ...ports])];
}

function candidateHosts(): string[] {
  const hosts = new Set<string>(["127.0.0.1", ...localIpv4Addresses()]);
  for (const address of localIpv4Addresses()) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4) continue;
    for (let i = 1; i <= 254; i += 1) {
      hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
    }
  }
  return [...hosts];
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, any> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as Record<string, any>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverInstances(ctx: RabiApiContext, request: http.IncomingMessage, requestUrl: URL): Promise<RabiInstance[]> {
  const timeoutMs = Math.max(120, Math.min(3000, Number(requestUrl.searchParams.get("timeoutMs") || 450)));
  const ports = parsePorts(requestUrl.searchParams.get("ports"), ctx.managerPort);
  const targets = candidateHosts().flatMap((host) => ports.map((port) => ({ host, port, baseUrl: `http://${host}:${port}` })));
  const found = new Map<string, RabiInstance>();
  const self = identityPayload(ctx, request).data;
  found.set(self.guid, self);
  const workers = targets.map(async (target) => {
    const body = await fetchJson(`${target.baseUrl}/api/rabi/identity`, timeoutMs);
    const data = body?.data;
    if (!data?.guid) return;
    found.set(String(data.guid), {
      guid: String(data.guid),
      name: String(data.name || data.computerName || "RabiRoute"),
      computerName: String(data.computerName || ""),
      deviceType: String(data.deviceType || "RabiRoute Manager"),
      host: target.host,
      port: target.port,
      baseUrl: target.baseUrl,
      version: data.version ? String(data.version) : undefined,
      addresses: Array.isArray(data.addresses) ? data.addresses.map(String) : undefined,
      self: String(data.guid) === self.guid
    });
  });
  await Promise.allSettled(workers);
  return [...found.values()].sort((left, right) => Number(Boolean(right.self)) - Number(Boolean(left.self)) || left.name.localeCompare(right.name));
}

async function findInstance(ctx: RabiApiContext, request: http.IncomingMessage, requestUrl: URL, guid: string): Promise<RabiInstance | null> {
  const self = identityPayload(ctx, request).data;
  if (guid === self.guid) return self;
  return (await discoverInstances(ctx, request, requestUrl)).find((item) => item.guid === guid) ?? null;
}

async function proxyJson(instance: RabiInstance, path: string, init: RequestInit, timeoutMs = 3000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${instance.baseUrl}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { code: -1, message: text };
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function isSelfGuid(ctx: RabiApiContext, guid: string): boolean {
  return ctx.globalConfig.read().rabiGuid === guid;
}

export function handleRabiApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, ctx: RabiApiContext): boolean {
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/api/rabi/identity") {
    jsonResponse(response, 200, identityPayload(ctx, request));
    return true;
  }
  if (request.method === "PATCH" && pathname === "/api/rabi/identity") {
    void readJsonBody<Partial<{ rabiName: string }>>(request)
      .then((body) => ctx.globalConfig.patch({ rabiName: body.rabiName }))
      .then((config) => jsonResponse(response, 200, { code: 0, data: config }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && pathname === "/api/rabi/instances") {
    void discoverInstances(ctx, request, requestUrl)
      .then((items) => jsonResponse(response, 200, { code: 0, data: { instances: items } }))
      .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  const routeMatch = pathname.match(/^\/api\/rabi\/instances\/([^/]+)\/routes(?:\/([^/]+)(?:\/(agent-options|agent-binding|rabilink-replies))?)?$/);
  if (!routeMatch) return false;

  const guid = decodeURIComponent(routeMatch[1]);
  const routeId = routeMatch[2] ? decodeURIComponent(routeMatch[2]) : "";
  const action = routeMatch[3] || "";

  if (request.method === "GET" && !routeId && !action) {
    if (isSelfGuid(ctx, guid)) {
      jsonResponse(response, 200, localRoutes(ctx));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && routeId && action === "agent-options") {
    if (isSelfGuid(ctx, guid)) {
      void localAgentOptions(ctx, routeId)
        .then((result) => jsonResponse(response, result.code === 0 ? 200 : 404, result))
        .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/agent-options`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && routeId && action === "rabilink-replies") {
    if (isSelfGuid(ctx, guid)) {
      jsonResponse(response, 200, localRabiLinkReplies(ctx, routeId, requestUrl));
      return true;
    }
    void findInstance(ctx, request, requestUrl, guid)
      .then((instance) => {
        if (!instance) return jsonResponse(response, 404, { code: -1, message: `RabiRoute instance not found: ${guid}` });
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/rabilink-replies${requestUrl.search}`, { method: "GET" })
          .then((result) => jsonResponse(response, result.status, result.body));
      })
      .catch((error) => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if ((request.method === "PATCH" || request.method === "POST") && routeId && action === "agent-binding") {
    void readJsonBody<AgentBindingPatch>(request)
      .then(async (body) => {
        if (isSelfGuid(ctx, guid)) return { status: 200, body: setLocalAgentBinding(ctx, routeId, body) };
        const instance = await findInstance(ctx, request, requestUrl, guid);
        if (!instance) return { status: 404, body: { code: -1, message: `RabiRoute instance not found: ${guid}` } };
        return proxyJson(instance, `/api/rabi/instances/${encodeURIComponent(guid)}/routes/${encodeURIComponent(routeId)}/agent-binding`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      })
      .then((result) => jsonResponse(response, result.status, result.body))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}

import type http from "node:http";
import type {
  AstrbotLoginTestRequest,
  MarvisOpenRequest
} from "../agentAdapters/managerApi.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export type AgentProviderControlProvider = "copilot" | "astrbot" | "marvis";

export type CopilotInstallResult = {
  stdout?: string;
  stderr?: string;
};

export type CopilotLoginExitStatus = {
  done: boolean;
  exitCode: number | null;
  error: string;
};

export type CopilotLoginResult =
  | {
      kind: "device-code";
      code: string;
      url: string | null;
      pid?: number;
    }
  | {
      kind: "completed";
    }
  | {
      kind: "timeout";
      error?: string;
    }
  | {
      kind: "failed";
      error: string;
    };

export type AstrbotLoginTestResult = Record<string, unknown> & {
  ok: boolean;
};

export type AgentProviderTrackOperation = <T>(operation: Promise<T>) => Promise<T>;

export type AgentProviderHttpRoutesContext = {
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  trackOperation?: AgentProviderTrackOperation;
};

export type CopilotControlRoutesContext = AgentProviderHttpRoutesContext & {
  installCopilot: () => Promise<CopilotInstallResult>;
  startCopilotLogin: (callbacks: {
    onExit: (status: CopilotLoginExitStatus) => void;
  }) => Promise<CopilotLoginResult>;
  getCopilotStatus: () => Promise<Record<string, unknown>>;
  publishEvent: (eventType: string, data: unknown) => void;
};

export type AstrbotControlRoutesContext = AgentProviderHttpRoutesContext & {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  testAstrbotLogin: (request: AstrbotLoginTestRequest) => Promise<AstrbotLoginTestResult>;
};

export type MarvisControlRoutesContext = AgentProviderHttpRoutesContext & {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  openMarvis: (request: MarvisOpenRequest) => Record<string, unknown>;
};


export type AgentProviderControlRoutesContextMap = {
  copilot: CopilotControlRoutesContext;
  astrbot: AstrbotControlRoutesContext;
  marvis: MarvisControlRoutesContext;
};

export type AgentProviderControlRouteInstance = {
  [Provider in AgentProviderControlProvider]: {
    provider: Provider;
    context: AgentProviderControlRoutesContextMap[Provider];
  }
}[AgentProviderControlProvider];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function runTrackedOperation<T>(
  context: AgentProviderHttpRoutesContext,
  operation: Promise<T>
): void {
  void (context.trackOperation?.(operation) ?? operation);
}

function handleCopilotInstall(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: CopilotControlRoutesContext
): boolean {
  if (request.method !== "POST" || requestUrl.pathname !== "/api/agent/copilot-install") return false;

  runTrackedOperation(context, context.installCopilot()
    .then(({ stdout = "", stderr = "" }) => context.jsonResponse(response, 200, {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    }))
    .catch((error: unknown) => {
      const detail = error as { message?: string; stderr?: string };
      context.jsonResponse(response, 500, {
        ok: false,
        error: detail.message,
        stderr: detail.stderr
      });
    }));
  return true;
}

function copilotLoginResponse(
  response: http.ServerResponse,
  context: CopilotControlRoutesContext,
  result: CopilotLoginResult
): void {
  if (result.kind === "device-code") {
    context.jsonResponse(response, 200, {
      ok: true,
      code: result.code,
      url: result.url,
      pid: result.pid
    });
    return;
  }
  if (result.kind === "completed") {
    context.jsonResponse(response, 200, { ok: true, done: true });
    return;
  }
  if (result.kind === "timeout") {
    context.jsonResponse(response, 408, {
      ok: false,
      error: result.error || "Timeout waiting for device code"
    });
    return;
  }
  context.jsonResponse(response, 500, { ok: false, error: result.error });
}

function handleCopilotLogin(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: CopilotControlRoutesContext
): boolean {
  if (request.method !== "POST" || requestUrl.pathname !== "/api/agent/copilot-login") return false;

  runTrackedOperation(context, context.startCopilotLogin({
    onExit: (status) => context.publishEvent("copilot_login_status", status)
  })
    .then((result) => copilotLoginResponse(response, context, result))
    .catch((error) => context.jsonResponse(response, 500, {
      ok: false,
      error: String(error)
    })));
  return true;
}

function handleCopilotStatus(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: CopilotControlRoutesContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/agent/copilot-status") return false;

  runTrackedOperation(context, context.getCopilotStatus()
    .then((result) => context.jsonResponse(response, 200, result))
    .catch((error) => context.jsonResponse(response, 500, {
      ok: false,
      error: String(error)
    })));
  return true;
}

function handleCopilotControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: CopilotControlRoutesContext
): boolean {
  return handleCopilotInstall(request, requestUrl, response, context)
    || handleCopilotLogin(request, requestUrl, response, context)
    || handleCopilotStatus(request, requestUrl, response, context);
}

function handleAstrbotControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AstrbotControlRoutesContext
): boolean {
  if (request.method === "POST" && requestUrl.pathname === "/api/agent/astrbot-login-test") {
    runTrackedOperation(context, context.readJsonBody<AstrbotLoginTestRequest>(request)
      .then((body) => context.testAstrbotLogin(body))
      .then((result) => context.jsonResponse(response, result.ok ? 200 : 400, result))
      .catch((error) => context.jsonResponse(response, 400, {
        ok: false,
        message: errorMessage(error)
      })));
    return true;
  }

  return false;
}

function handleMarvisControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: MarvisControlRoutesContext
): boolean {
  if (request.method !== "POST" || requestUrl.pathname !== "/api/agent/marvis-open") return false;

  runTrackedOperation(context, context.readJsonBody<MarvisOpenRequest>(request)
    .then((body) => context.openMarvis(body))
    .then((result) => context.jsonResponse(response, 200, result))
    .catch((error) => context.jsonResponse(response, 400, {
      ok: false,
      message: errorMessage(error)
    })));
  return true;
}

export function handleAgentProviderControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  instance: AgentProviderControlRouteInstance
): boolean {
  switch (instance.provider) {
    case "copilot":
      return handleCopilotControlApi(request, requestUrl, response, instance.context);
    case "astrbot":
      return handleAstrbotControlApi(request, requestUrl, response, instance.context);
    case "marvis":
      return handleMarvisControlApi(request, requestUrl, response, instance.context);
  }
}

export function createAgentProviderControlRouteHandler<Provider extends AgentProviderControlProvider>(
  provider: Provider,
  context: AgentProviderControlRoutesContextMap[Provider],
  trackOperation?: AgentProviderTrackOperation
): ManagerPluginRouteHandler {
  const instance = {
    provider,
    context: trackOperation ? { ...context, trackOperation } : context
  } as AgentProviderControlRouteInstance;
  return (request, requestUrl, response) => handleAgentProviderControlApi(
    request,
    requestUrl,
    response,
    instance
  );
}

export type CodexRouteBinding = {
  id?: string;
  name?: string;
  agentAdapters?: unknown[];
  codexThreadId?: string;
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
};

export type CodexBindingResolveRequest = {
  action: "resolve";
  threadId?: string;
  title: string;
  cwd?: string;
  createIfMissing: true;
  agentAdapter?: "codex" | "dsh";
  dshBaseUrl?: string;
};

export type CodexBindingResolveResponse = {
  statusCode: number;
  data: Record<string, unknown>;
};

export type CodexBindingResolver = (
  request: CodexBindingResolveRequest
) => Promise<CodexBindingResolveResponse>;

function configuredCodexTitle(gateway: CodexRouteBinding): string {
  return gateway.codexThreadName?.trim()
    || gateway.name?.trim()
    || gateway.id?.trim()
    || "Rabi";
}

/** Resolve/create exactly once at the save boundary, then persist the owner ID. */
export async function bindCodexSessionForSave(
  gateway: CodexRouteBinding,
  resolve: CodexBindingResolver
): Promise<void> {
  if (!gateway.agentAdapters?.includes("codex")) return;

  const title = configuredCodexTitle(gateway);
  const result = await resolve({
    action: "resolve",
    threadId: gateway.codexThreadId?.trim() || undefined,
    title,
    cwd: gateway.codexCwd?.trim() || undefined,
    createIfMissing: true
  });
  const thread = result.data.thread as Record<string, unknown> | undefined;
  if (result.statusCode < 200 || result.statusCode >= 300 || typeof thread?.id !== "string" || !thread.id) {
    const message = typeof result.data.message === "string"
      ? result.data.message
      : "无法查找或创建 Codex Desktop 会话。";
    throw new Error(message);
  }

  gateway.codexThreadId = thread.id;
  gateway.codexThreadName = typeof thread.title === "string" && thread.title ? thread.title : title;
  if (typeof thread.cwd === "string" && thread.cwd) gateway.codexCwd = thread.cwd;
}
function configuredDshTitle(gateway: CodexRouteBinding): string {
  return gateway.dshSessionName?.trim()
    || gateway.name?.trim()
    || gateway.id?.trim()
    || "Rabi";
}

/** Resolve/create the configured DSH session at the save boundary, then persist its owner ID. */
export async function bindDshSessionForSave(
  gateway: CodexRouteBinding,
  resolve: CodexBindingResolver
): Promise<void> {
  if (!gateway.agentAdapters?.includes("dsh")) return;

  const title = configuredDshTitle(gateway);
  const result = await resolve({
    action: "resolve",
    agentAdapter: "dsh",
    threadId: gateway.dshSessionId?.trim() || undefined,
    title,
    cwd: gateway.dshCwd?.trim() || undefined,
    createIfMissing: true,
    dshBaseUrl: gateway.dshBaseUrl?.trim() || undefined
  });
  const thread = result.data.thread as Record<string, unknown> | undefined;
  if (result.statusCode < 200 || result.statusCode >= 300 || typeof thread?.id !== "string" || !thread.id) {
    const message = typeof result.data.message === "string"
      ? result.data.message
      : "无法查找或创建 DSH 会话。";
    throw new Error(message);
  }

  gateway.dshSessionId = thread.id;
  gateway.dshSessionName = typeof thread.title === "string" && thread.title ? thread.title : title;
  if (typeof thread.cwd === "string" && thread.cwd) gateway.dshCwd = thread.cwd;
}

export async function bindAgentSessionsForSave(
  gateway: CodexRouteBinding,
  resolve: CodexBindingResolver
): Promise<void> {
  await bindCodexSessionForSave(gateway, resolve);
  await bindDshSessionForSave(gateway, resolve);
}

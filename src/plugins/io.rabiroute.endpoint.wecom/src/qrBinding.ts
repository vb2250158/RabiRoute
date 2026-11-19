import QRCode from "qrcode";
import type { ApiOperationDefinition, ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { setTimeout as delay } from "node:timers/promises";
type Credentials = Pick<GatewayDefinition, "wecomBotId" | "wecomBotSecret">;
type Result =
  | { state: "waiting"; qrCodeDataUrl?: string }
  | { state: "ready"; accountId: string }
  | { state: "failed"; message: string }
  | { state: "cancelled" };

type Manager = {
  access(request: ApiOperationInput["request"], url: URL): boolean;
  readOnly: boolean;
  lifecycleFence: { applicationGenerationId: string; managerInstanceId: string };
  readRoutes(): GatewayDefinition[];
  routeVersion(): string;
  writeRoute(id: string, route: GatewayDefinition, revision: string, operationId: string): Promise<void>;
  resolveRouteMutation(id: string): Promise<{ state: string }>;
  syncRoutes(): void;
};

type PlatformResponse = { data?: {
  scode?: string; auth_url?: string; status?: string; bot_info?: { botid?: string; secret?: string };
} };

async function authorize(signal: AbortSignal, onQr: (url: string) => Promise<void>): Promise<Credentials> {
  async function read(action: "generate" | "query_result", query: Record<string, string>): Promise<PlatformResponse["data"]> {
    const url = new URL("https://work.weixin.qq.com/ai/qc/" + action);
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!response.ok) throw new Error("WeCom QR request failed");
    return ((await response.json()) as PlatformResponse).data;
  }
  // Supported by the official WeCom CLI's QR registration flow.
  const code = await read("generate", { source: "wecom_cli_external", plat: process.platform === "win32" ? "2" : process.platform === "darwin" ? "1" : "3" });
  if (!code?.scode || !code.auth_url) throw new Error("WeCom QR missing");
  await onQr(code.auth_url);
  while (!signal.aborted) {
    const state = await read("query_result", { scode: code.scode });
    if (state?.status === "success") {
      const { botid, secret } = state.bot_info ?? {};
      if (!botid || !secret) throw new Error("WeCom credentials missing");
      return { wecomBotId: botid, wecomBotSecret: secret };
    }
    await delay(3000, undefined, { signal });
  }
  throw signal.reason;
}

export function createQrOperations(manager: Manager, lifetime: AbortSignal): ApiOperationDefinition[] {
  const duration = 5 * 60_000;
  const sessions = new Map<string, {
    routeId: string;
    controller: AbortController;
    result: Result;
    timer: ReturnType<typeof setTimeout>;
    committing: boolean;
  }>();
  lifetime.addEventListener("abort", () => {
    for (const session of sessions.values()) {
      clearTimeout(session.timer);
      session.controller.abort();
    }
    sessions.clear();
  }, { once: true });

  const path = "/api/message/wecom/routes/:routeId/qr/:id";
  const envelope = { type: "object", additionalProperties: true } as const;
  const empty = { type: "object", additionalProperties: false } as const;
  const responseHeaders = { "cache-control": "no-store" };
  const error = (status: number, message: string) => ({ status, headers: responseHeaders, body: { code: -1, message } });
  const reply = (data: Result) => ({ status: 200, headers: responseHeaders, body: { code: 0, data } });

  return (["POST", "GET", "DELETE"] as const).map((method, index) => ({
    contract: {
      operationId: "manager.wecom.qr." + ["start", "status", "cancel"][index],
      contractVersion: "1.0.0", method, pathTemplate: path, transport: "http", exposure: "public",
      description: "管理企业微信机器人扫码会话。",
      request: { path: { ...empty, properties: {
        routeId: { type: "string", minLength: 1, maxLength: 256 }, id: { type: "string", pattern: "^[0-9a-f-]{36}$" }
      }, required: ["routeId", "id"] }, query: empty, headers: envelope, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema: envelope }, default: { mediaType: "application/json", schema: envelope } },
      effects: { mode: method === "GET" ? "native-read" : "credential-management", description: "企业微信扫码接入" },
      recovery: { strategy: "read-current-state", description: "使用原 Route 和扫码会话编号查询状态。" },
      validators: [{ id: "qr-manager-fence", description: "校验当前 Manager 身份和原 Route 扫码会话。" }]
    },
    handler(input) {
      if (!manager.access(input.request, input.url)) return error(403, "当前连接无权管理机器人。");
      if (lifetime.aborted || manager.readOnly) return error(503, "扫码接入暂不可用。");
      const fence = manager.lifecycleFence;
      if (input.request.headers["x-rabiroute-expected-application-generation-id"] !== fence.applicationGenerationId
        || input.request.headers["x-rabiroute-expected-manager-instance-id"] !== fence.managerInstanceId) {
        return error(409, "Manager 已换版，请刷新页面。");
      }
      const { routeId, id } = input.path as { routeId: string; id: string };
      const existing = sessions.get(id);
      if (existing) {
        if (existing.routeId !== routeId) return error(404, "扫码会话不存在。");
        if (method === "DELETE" && existing.result.state === "waiting" && !existing.committing) {
          existing.controller.abort();
          existing.result = { state: "cancelled" };
        }
        return reply(existing.result);
      }
      if (method !== "POST") return error(404, "扫码会话已结束，请重新扫码。");
      const original = manager.readRoutes().find(route => route.id === routeId);
      if (!original?.messageAdapters?.includes("wecom")) return error(409, "请先保存已添加的消息端。");
      const controller = new AbortController();
      const session = { routeId, controller, result: { state: "waiting" } as Result, committing: false,
        timer: setTimeout(() => { controller.abort(); sessions.delete(id); }, duration).unref() };
      sessions.set(id, session);
      void (async () => {
        try {
          const credentials = await authorize(controller.signal, async url => {
            const qrCodeDataUrl = await QRCode.toDataURL(url, { width: 384 });
            if (!controller.signal.aborted && session.result.state === "waiting") session.result = { state: "waiting", qrCodeDataUrl };
          });
          if (controller.signal.aborted) return;
          const revision = manager.routeVersion();
          const current = manager.readRoutes().find(route => route.id === routeId);
          if (!current?.messageAdapters?.includes("wecom") || current.configName !== original.configName
            || ["wecomBotId", "wecomBotSecret"].some(key => current[key as keyof Credentials] !== original[key as keyof Credentials])) {
            session.result = { state: "failed", message: "接入配置已变化，请重新打开连接弹窗。" };
            return;
          }
          session.committing = true;
          const mutationId = "wecom-qr:" + id;
          try {
            await manager.writeRoute(routeId, { ...current, ...credentials }, revision, mutationId);
          } catch {
            if ((await manager.resolveRouteMutation(mutationId)).state !== "committed") throw new Error("Route write not confirmed");
          }
          manager.syncRoutes();
          session.result = { state: "ready", accountId: credentials.wecomBotId! };
        } catch {
          if (!controller.signal.aborted) session.result = { state: "failed", message: "企业微信扫码未完成，请重新获取二维码或手动配置。" };
        }
      })();
      return reply(session.result);
    }
  } satisfies ApiOperationDefinition));
}

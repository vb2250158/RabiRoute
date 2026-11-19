import { startQrConnect, type QrConnectCredentials } from "@tencent-connect/qqbot-connector";
import QRCode from "qrcode";
import type { ApiOperationDefinition, ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { AccountSnapshot, createBotAccounts } from "./accounts.js";
import type { createBotApi } from "./protocol.js";

const path = "/api/message/qqbot/qr/:id";
const sessionLifetime = 5 * 60_000;
const empty = { type: "object", additionalProperties: false } as const;
const envelope = { type: "object", additionalProperties: true } as const;

type BindingState =
  | { state: "waiting"; qrCodeDataUrl?: string }
  | { state: "ready"; accounts: AccountSnapshot[] }
  | { state: "failed"; message: string }
  | { state: "cancelled" };

type Session = {
  result: BindingState;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  qrRevision: number;
};

type BindingManager = {
  readOnly: boolean;
  access(request: ApiOperationInput["request"], url: URL): boolean;
  lifecycleFence: { applicationGenerationId: string; managerInstanceId: string };
};

export function createBotQrOperations(
  accounts: ReturnType<typeof createBotAccounts>,
  api: Pick<ReturnType<typeof createBotApi>, "check">,
  manager: BindingManager,
  signal: AbortSignal,
  connector: typeof startQrConnect = startQrConnect
): ApiOperationDefinition[] {
  const sessions = new Map<string, Session>();
  signal.addEventListener("abort", () => {
    for (const session of sessions.values()) {
      clearTimeout(session.timer);
      session.controller.abort();
    }
    sessions.clear();
  }, { once: true });

  function finish(id: string, session: Session, result: BindingState): void {
    clearTimeout(session.timer);
    session.result = result;
    session.controller.abort();
    session.timer = setTimeout(() => sessions.delete(id), sessionLifetime).unref();
  }

  function fail(id: string, session: Session, message: string): void {
    if (!session.controller.signal.aborted) finish(id, session, { state: "failed", message });
  }

  async function publishQr(id: string, session: Session, url: string): Promise<void> {
    const revision = ++session.qrRevision;
    try {
      const qrCodeDataUrl = await QRCode.toDataURL(url, { width: 384 });
      if (!session.controller.signal.aborted && revision === session.qrRevision) session.result = { state: "waiting", qrCodeDataUrl };
    } catch {
      fail(id, session, "无法生成 QQ 登录二维码，请重新扫码。");
    }
  }

  async function authorize(id: string, session: Session, selected: QrConnectCredentials[]): Promise<void> {
    // The official connector currently authorizes one bot selected in mobile QQ.
    const [chosen] = selected;
    if (selected.length !== 1 || !chosen || !/^\d{1,32}$/.test(chosen.appId) || !chosen.appSecret?.trim() || chosen.appSecret.length > 256) {
      fail(id, session, "QQ 未返回已选机器人的有效凭据，请重新扫码。");
      return;
    }
    const credentials = { appId: chosen.appId, appSecret: chosen.appSecret, sandbox: false };
    try {
      const existing = accounts.list().find(account => account.appId === credentials.appId && !account.sandbox);
      const current = existing ? accounts.credentials(existing.id) : undefined;
      await api.check(credentials);
      if (session.controller.signal.aborted || signal.aborted) return;
      const account = accounts.update({ id: existing?.id, expected: existing?.revision,
        requestId: `qqbot-qr:${id}`, credentials, checked: current?.appSecret === credentials.appSecret });
      finish(id, session, { state: "ready", accounts: [account] });
    } catch {
      fail(id, session, "QQ 机器人验证或保存失败，请重新扫码。");
    }
  }

  function start(id: string): Session {
    const session: Session = { result: { state: "waiting" }, controller: new AbortController(), qrRevision: 0 };
    sessions.set(id, session);
    session.timer = setTimeout(() => fail(id, session, "二维码已过期，请重新扫码。"), sessionLifetime).unref();
    try {
      connector({
        onQrDisplayed: url => { void publishQr(id, session, url); },
        onQrExpired: () => {
          session.qrRevision++;
          if (!session.controller.signal.aborted) session.result = { state: "waiting" };
        },
        onSuccess: selected => { void authorize(id, session, selected); },
        onFailure: () => fail(id, session, "QQ 扫码连接失败，请重新扫码。")
      }, { displayQrCodeToConsole: false, signal: session.controller.signal });
    } catch {
      fail(id, session, "无法启动 QQ 扫码连接，请重试。");
    }
    return session;
  }

  const failure = (status: number, message: string) => ({ status, headers: { "cache-control": "no-store" }, body: { code: -1, message } });
  const success = (data: BindingState) => ({ status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data } });
  const endpoints = [
    { method: "POST", name: "start", description: "生成 QQ 机器人扫码绑定二维码。" },
    { method: "GET", name: "status", description: "查询 QQ 机器人扫码结果。" },
    { method: "DELETE", name: "cancel", description: "取消 QQ 机器人扫码绑定。" }
  ] as const;
  return endpoints.map(({ method, name, description }): ApiOperationDefinition => ({
    contract: {
      operationId: `manager.qqbot.qr.${name}`, contractVersion: "1.0.0", method,
      pathTemplate: path, transport: "http", exposure: "public", description,
      request: { path: { ...empty, properties: { id: { type: "string", pattern: "^[0-9a-f-]{36}$" } }, required: ["id"] },
        query: empty, headers: envelope, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema: envelope }, default: { mediaType: "application/json", schema: envelope } },
      effects: { mode: method === "GET" ? "native-read" : "credential-management", description },
      recovery: { strategy: "original-qr-session", receiptPath: path, description: "查询原扫码会话以确认状态。" },
      validators: [{ id: "qqbot-manager-fence", description: "所有扫码请求均使用同一个会话编号和当前 Manager 实例。" }]
    },
    handler(input) {
      if (!manager.access(input.request, input.url)) return failure(403, "当前连接无权管理 QQ 机器人。");
      if (signal.aborted || manager.readOnly) return failure(503, "QQ 机器人扫码连接暂不可用。");
      const fence = manager.lifecycleFence;
      if (input.request.headers["x-rabiroute-expected-application-generation-id"] !== fence.applicationGenerationId
        || input.request.headers["x-rabiroute-expected-manager-instance-id"] !== fence.managerInstanceId) {
        return failure(409, "Manager 已换版，请刷新页面。");
      }
      const id = input.path.id!;
      const session = sessions.get(id);
      if (method === "POST") return success((session ?? start(id)).result);
      if (!session) return failure(404, "扫码会话已结束，请重新扫码。");
      if (method === "DELETE" && session.result.state === "waiting") finish(id, session, { state: "cancelled" });
      return success(session.result);
    }
  }));
}

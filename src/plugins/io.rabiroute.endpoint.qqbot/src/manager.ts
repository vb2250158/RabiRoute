import type { ApiOperationDefinition, ApiOperationInput, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import type { QqBotMessageRecord } from "@rabiroute/host-api/history";
import { AccountConflict, createBotAccounts } from "./accounts.js";
import { createBotApi, type BotCredentials } from "./protocol.js";

const root = "/api/message/qqbot/accounts";
const empty = { type: "object", additionalProperties: false } as const;
const fields = { appId: { type: "string", pattern: "^\\d{1,32}$" }, appSecret: { type: "string", minLength: 1, maxLength: 256 }, sandbox: { type: "boolean" } } as const;
const revision = { type: "string", minLength: 1, maxLength: 64 } as const;
const envelope = { type: "object", additionalProperties: true } as const;

export function createBotEgress(accounts: ReturnType<typeof createBotAccounts>, api: ReturnType<typeof createBotApi>,
  assertRoute: (source: QqBotMessageRecord) => void) {
  return {
    async reply(source: QqBotMessageRecord, text: string) {
      const currentAccount = () => {
        assertRoute(source);
        const account = accounts.credentials(source.instanceId);
        if (!account || account.revision !== source.accountRevision) throw new Error("来源机器人凭据已变更，请通过新收到的消息回复。");
        return account;
      };
      const account = currentAccount();
      return api.reply(account, account.revision, source, text, currentAccount);
    }
  };
}

export function createBotOperations(
  accounts: ReturnType<typeof createBotAccounts>,
  api: ReturnType<typeof createBotApi>,
  manager: { readOnly: boolean; access(request: ApiOperationInput["request"], url: URL): boolean;
    lifecycleFence: { applicationGenerationId: string; managerInstanceId: string } },
  signal: AbortSignal
): ApiOperationDefinition[] {
  const failure = (status: number, message: string) => ({ status, body: { code: -1, message } });
  const success = (data: unknown) => ({ status: 200, body: { code: 0, data } });
  const operations: ApiOperationDefinition[] = [];
  const add = (name: string, method: "GET" | "POST" | "DELETE", suffix: string, description: string, schema?: ApiSchema) => {
    const mutation = method !== "GET";
    const hasId = suffix.includes(":id");
    operations.push({
      contract: {
        operationId: "manager.qqbot.accounts." + name, contractVersion: "1.0.0", method,
        pathTemplate: root + suffix, transport: "http", exposure: "public", description,
        request: { path: hasId ? { ...empty, properties: { id: { type: "string", pattern: "^[0-9a-f-]{36}$" } }, required: ["id"] } : empty,
          query: empty, headers: envelope, body: schema ? { kind: "json", schema, maxBytes: 4096 } : { kind: "none" } },
        responses: { "200": { mediaType: "application/json", schema: envelope }, default: { mediaType: "application/json", schema: envelope } },
        effects: { mode: mutation ? "credential-management" : "native-read", description },
        recovery: { strategy: mutation ? "original-account-receipt" : "repeatable-read", description: "Read the saved account and reuse the original request key if the response was lost.",
          ...(mutation ? { idempotencyHeader: "Idempotency-Key" } : {}) },
        validators: [{ id: "qqbot-manager-fence", description: "Use the current Manager identity and account revision for credential changes." }]
      },
      prepare(input) {
        if (!manager.access(input.request, input.url)) return failure(403, "当前连接无权管理 QQ 机器人。");
        if (!mutation) return () => success(accounts.list());
        if (manager.readOnly || signal.aborted) return failure(503, "QQ 机器人账号管理暂不可写。");
        const headers = input.request.headers;
        const fence = manager.lifecycleFence;
        if (headers["x-rabiroute-expected-application-generation-id"] !== fence.applicationGenerationId
          || headers["x-rabiroute-expected-manager-instance-id"] !== fence.managerInstanceId) return failure(409, "Manager 已换版，请刷新页面。");
        const requestId = headers["idempotency-key"];
        if (typeof requestId !== "string" || !/^[a-zA-Z0-9._:-]{16,200}$/.test(requestId)) return failure(400, "需要本次操作的请求编号。");
        return async full => {
          try {
            signal.throwIfAborted();
            full.signal?.throwIfAborted();
            const id = hasId ? full.path.id : undefined;
            const repeated = accounts.receipt(requestId, id);
            if (repeated) return success(repeated);
            const body = full.body as BotCredentials & { revision?: string };
            const checked = name === "refresh";
            const credentials = checked ? accounts.credentials(id!) : method === "POST"
              ? { appId: body.appId, appSecret: body.appSecret, sandbox: body.sandbox } : undefined;
            if (checked && !credentials) return failure(409, "请先授权该 QQ 机器人。");
            if (credentials) {
              if (!credentials.appSecret.trim()) return failure(400, "请输入 QQ 机器人 AppSecret。");
              try { await api.check(credentials); }
              catch { return failure(422, "QQ 开放平台凭据检查失败，请核对 AppID、AppSecret 和网络。"); }
            }
            signal.throwIfAborted();
            full.signal?.throwIfAborted();
            return success(accounts.update({ id, expected: body.revision, requestId, credentials, checked }));
          } catch (error) {
            if (error instanceof AccountConflict) return failure(409, error.message);
            return failure(503, "QQ 机器人账号状态暂不可读写。请刷新确认结果。");
          }
        };
      },
      handler: () => failure(503, "QQ 机器人账号管理暂不可用。")
    });
  };
  add("list", "GET", "", "列出已授权及待授权的 QQ 机器人账号。");
  add("create", "POST", "", "验证并添加 QQ 机器人账号。", { ...empty, properties: fields, required: ["appId", "appSecret", "sandbox"] });
  add("authorize", "POST", "/:id/auth", "为已有 QQ 机器人账号重新授权。", { ...empty, properties: { ...fields, revision }, required: ["appId", "appSecret", "sandbox", "revision"] });
  add("refresh", "POST", "/:id/auth/refresh", "向 QQ 开放平台验证现有账号凭据。", { ...empty, properties: { revision }, required: ["revision"] });
  add("logout", "DELETE", "/:id/auth", "删除本机保存的 QQ 机器人凭据。", { ...empty, properties: { revision }, required: ["revision"] });
  return operations;
}

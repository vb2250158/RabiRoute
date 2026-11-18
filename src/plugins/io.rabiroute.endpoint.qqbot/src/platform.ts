import { createHash } from "node:crypto";
import type { ApiBodyContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { messageAdapterOutputEnabled, type GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { createBotAccounts } from "./accounts.js";
import { botCapabilities, type BotCapability } from "./catalog.js";
import type { BotContent, BotNativeResult, createBotApi } from "./protocol.js";
import { parseLargeFile, uploadLargeFile, type BotLargeFileInput } from "./media.js";

const base = "/api/message/qqbot/routes/:routeId/platform";
const routeId = { type: "string", minLength: 1, maxLength: 200 };
const opaque = { type: "object", additionalProperties: true } as const;
const platformId = { type: "string", pattern: "^[A-Za-z0-9_+-][A-Za-z0-9_.=+-]{0,255}$" };
const deliveryId = { type: "string", pattern: "^[A-Za-z0-9._:-]{16,200}$" };
const query = { type: "object", additionalProperties: { anyOf: [{ type: "string", maxLength: 2048 },
  { type: "array", maxItems: 20, items: { type: "string", maxLength: 2048 } }] }, maxProperties: 30 };
const none = { kind: "none" } as const;
const documented = "https://bot.q.qq.com/wiki/develop/api-v2/";

type PlatformManager = {
  rootDir: string;
  readOnly: boolean;
  readRoute(id: string): GatewayDefinition | undefined;
  access(request: ApiOperationInput["request"], url: URL): boolean;
  lifecycleFence: { applicationGenerationId: string; managerInstanceId: string };
};

function routeNamespace(id: string) {
  return "qqbot-platform-" + createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function contentBody(input: unknown, mode?: string): BotContent | undefined {
  if (!mode || input == null) return;
  const data = input as Record<string, unknown>;
  const file = data.fileImage as { name: string; contentType: string; base64: string } | undefined;
  if (mode !== "multipart" || !file) return data;
  const bytes = Buffer.from(file.base64, "base64");
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString("base64") !== file.base64) {
    throw new Error("附件请使用有效的 Base64 编码，文件大小上限 16 MiB。");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(data)) {
    if (key !== "fileImage" && value !== undefined) form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.append("file_image", new Blob([new Uint8Array(bytes)], { type: file.contentType }), file.name);
  return form;
}

function requestBody(mode?: string): ApiBodyContract {
  if (mode === "large-file") return { kind: "json", maxBytes: 45 * 1024 * 1024, schema: {
    type: "object", additionalProperties: false, required: ["name", "fileType", "base64"], properties: {
      name: { type: "string", pattern: "^[^\\x00-\\x1f/\\\\]{1,255}$" },
      fileType: { enum: [1, 2, 3, 4] }, base64: { type: "string", minLength: 4, maxLength: 44739244 }
    }
  } };
  if (mode !== "multipart") return mode
    ? { kind: "json", schema: opaque, maxBytes: 24 * 1024 * 1024, emptyValue: {} }
    : none;
  return { kind: "json", maxBytes: 24 * 1024 * 1024, schema: {
    ...opaque, properties: { fileImage: {
      type: "object", additionalProperties: false, required: ["name", "contentType", "base64"],
      properties: { name: { type: "string", pattern: "^[^\\x00-\\x1f/\\\\]{1,255}$" },
        contentType: { type: "string", pattern: "^image/[A-Za-z0-9.+-]{1,60}$" },
        base64: { type: "string", minLength: 4, maxLength: 22369624 } }
    } }
  }, emptyValue: {} };
}

export function createBotPlatformOperations(accounts: ReturnType<typeof createBotAccounts>,
  api: ReturnType<typeof createBotApi>, manager: PlatformManager, lifecycle: AbortSignal): ApiOperationDefinition[] {
  const result = (status: number, data: unknown): ApiOperationResult => ({ status, body: { code: status < 300 ? 0 : -1, data } });
  const failure = (status: number, message: string): ApiOperationResult => ({ status, body: { code: -1, message } });
  const replies = { "200": { mediaType: "application/json", schema: opaque }, default: { mediaType: "application/json", schema: opaque } };
  const definitions = (botCapabilities as readonly BotCapability[]).map(([id, method, template, area, title, inputMode, policy]): ApiOperationDefinition => {
    const mutation = method !== "GET";
    const keys = Array.from(template.matchAll(/\{(\w+)\}/g), match => match[1]);
    const pathTemplate = `${base}/${id}${keys.map(key => "/:" + key).join("")}`;
    const description = inputMode === "large-file"
      ? `${title}。依次调用腾讯 upload_prepare、上传分片、upload_part_finish 与 files。平台权限见 ${documented}`
      : `${title}。腾讯 OpenAPI ${method} ${template}。原生参数与平台权限见 ${documented}`;
    return {
      contract: { operationId: "manager.qqbot.platform." + id, contractVersion: "1.0.0", method, pathTemplate,
        exposure: "public", transport: "http", description,
        request: { path: { type: "object", required: ["routeId", ...keys], additionalProperties: false,
          properties: { routeId, ...Object.fromEntries(keys.map(key => [key, platformId])) } },
          query: inputMode === "large-file" ? { type: "object", additionalProperties: false } : query,
          headers: opaque, body: requestBody(inputMode), deadlineMs: inputMode === "large-file" ? 180000 : 26000 },
        responses: replies,
        effects: { mode: policy === "output" ? "send-message-or-upload" : mutation ? "native-platform-mutation" : "native-platform-read", description },
        recovery: mutation ? { strategy: "durable-request-receipt", description: "Query the exact Route and Idempotency-Key after timeout.",
          receiptPath: base + "/receipts/:deliveryId", idempotencyHeader: "Idempotency-Key" }
          : { strategy: "repeatable-read", description: "Read again using the same Route and platform parameters." },
        validators: [{ id: "qqbot-platform-route-binding", description: "The active Route selects the bot account; HTTP method and destination template are fixed by the capability catalog." }]
      },
      discovery: { title, summary: description, tags: ["QQ 官方机器人", area], provider: "qqbot" },
      async handler(full) {
        if (!manager.access(full.request, full.url)) return failure(403, "当前连接无权调用 QQ 机器人。");
        if (lifecycle.aborted || (mutation && manager.readOnly)) return failure(503, "QQ 机器人操作入口暂不可写。");
        const route = manager.readRoute(full.path.routeId);
        const accountId = route?.qqbotAccountId;
        if (!route || route.enabled === false || !accountId || !route.messageAdapters?.includes("qqbot")
          || route.messageAdaptersDisabled?.includes("qqbot")) return failure(404, "未找到已绑定 QQ 机器人的 Route。");
        if (policy === "output" && !messageAdapterOutputEnabled(route, "qqbot")) return failure(403, "此 Route 已关闭 QQ 机器人的外发。");
        if (mutation && !policy && route.qqbotManagementEnabled === false) return failure(403, "此 Route 已关闭 QQ 频道管理操作。");
        const headers = full.request.headers;
        const key = headers["idempotency-key"];
        if (mutation) {
          if (headers["x-rabiroute-expected-application-generation-id"] !== manager.lifecycleFence.applicationGenerationId
            || headers["x-rabiroute-expected-manager-instance-id"] !== manager.lifecycleFence.managerInstanceId) {
            return failure(409, "Manager 已换版，请刷新身份。");
          }
          if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(key)) return failure(400, "请提供本次操作的 Idempotency-Key。");
        }
        const account = accounts.credentials(accountId);
        if (!account) return failure(409, "此 Route 的 QQ 机器人待授权。");
        let body: BotContent | undefined;
        let largeFile: ReturnType<typeof parseLargeFile> | undefined;
        try {
          if (inputMode === "large-file") largeFile = parseLargeFile(full.body as BotLargeFileInput);
          else body = contentBody(full.body, inputMode);
        }
        catch (error) { return failure(400, error instanceof Error ? error.message : "附件格式无效。"); }
        const params = new URLSearchParams();
        for (const [key, values] of Object.entries(full.query)) {
          for (const value of Array.isArray(values) ? values : [values]) params.append(key, value);
        }
        const target = template.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(full.path[name])) + (params.size ? "?" + params : "");
        const signal = full.signal ? AbortSignal.any([full.signal, lifecycle]) : lifecycle;
        const assertCurrent = () => {
          signal.throwIfAborted();
          if (!manager.access(full.request, full.url) || manager.readRoute(full.path.routeId) !== route
            || accounts.credentials(accountId)?.revision !== account.revision) throw new Error("原账号或 Route 已换版。");
        };
        const deliver = () => largeFile ? uploadLargeFile(target, largeFile,
          (pathname, nativeBody) => api.invoke(account, account.revision, method, pathname, nativeBody, assertCurrent, signal), assertCurrent, signal)
          : api.invoke(account, account.revision, method, target, body, assertCurrent, signal);
        if (!mutation) {
          try {
            const upstream = await deliver();
            return result(upstream.status < 300 ? 200 : upstream.status, upstream);
          }
          catch { return failure(502, "读取腾讯 QQ 机器人接口失败。"); }
        }
        const receipt = await executeDurableDelivery({ rootDir: manager.rootDir, namespace: routeNamespace(route.id),
          deliveryId: key, payload: { accountId, revision: account.revision, method, target, input: full.body },
          requestAuthority: assertCurrent, deliver });
        const status = receipt.state === "completed" ? (receipt.result.status < 300 ? 200 : receipt.result.status)
          : receipt.state === "conflict" ? 409 : 202;
        return result(status, receipt);
      }
    };
  });
  definitions.push({
    contract: { operationId: "manager.qqbot.platform.receipt", contractVersion: "1.0.0", method: "GET",
      pathTemplate: base + "/receipts/:deliveryId", exposure: "public", transport: "http", description: "查询 QQ 官方机器人的原平台操作回执。",
      request: { path: { type: "object", required: ["routeId", "deliveryId"], additionalProperties: false, properties: { routeId, deliveryId } },
        query: { type: "object", additionalProperties: false }, headers: opaque, body: none },
      responses: replies, effects: { mode: "receipt-read", description: "读取已保留的原平台响应，不重发。" },
      recovery: { strategy: "repeatable-read", description: "Keep the original Route and deliveryId." }, validators: [] },
    handler(full) {
      if (!manager.access(full.request, full.url)) return failure(403, "当前连接无权读取 QQ 机器人回执。");
      const receipt = readDurableDeliveryReceipt<BotNativeResult>(manager.rootDir, routeNamespace(full.path.routeId), full.path.deliveryId);
      return receipt ? result(200, { deliveryId: receipt.deliveryId, state: receipt.state, result: receipt.result })
        : failure(404, "未找到原 QQ 机器人操作回执。");
    }
  });
  return definitions;
}

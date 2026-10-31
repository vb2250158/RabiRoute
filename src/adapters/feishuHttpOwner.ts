import type http from "node:http";
import type { ApiHttpProxyInput } from "../manager/apiOperationContract.js";
import { handleFeishuCallback } from "./feishuNativeProtocol.js";
import type { FeishuAdapterSettings } from "./feishuAdapter.js";
import type { AdapterLogRecord, FeishuMessageRecord } from "../history.js";
import type { forwardMessage } from "../forwarding.js";

export type FeishuHttpOwnerContext = Readonly<{
  settings: FeishuAdapterSettings;
  memoryDataDir: string;
  accepting(): boolean;
  listening(): boolean;
  now(): Date;
  persist(record: FeishuMessageRecord, memoryDataDir: string): boolean;
  deliver: (...args: Parameters<typeof forwardMessage>) => unknown | Promise<unknown>;
  patchStatus(patch: Record<string, unknown>, now?: Date): void;
  appendLog(record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>): void;
}>;

const MAX_CALLBACK_BYTES = 1024 * 1024;

/** Raw bytes, exact pathname, authentication and event mapping remain owned by the native Feishu codec. */
export function createFeishuHttpOwner(context: FeishuHttpOwnerContext) {
  return async (request: http.IncomingMessage, response: http.ServerResponse, prepareResponse: ApiHttpProxyInput["prepareResponse"]): Promise<void> => {
    const respond = (status: number, headers: Record<string, string> = {}) => {
      prepareResponse(status, headers);
      return response.writeHead(status, headers);
    };
    if (!context.accepting()) {
      respond(503).end();
      return;
    }
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "POST" || requestPath !== context.settings.webhookPath) {
      respond(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        if (!context.accepting()) return;
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_CALLBACK_BYTES) {
          respond(413).end();
          return;
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (!context.accepting()) return;
      const message = error instanceof Error ? error.message : String(error);
      context.appendLog({ level: "warning", event: "request_aborted", message });
      if (!response.headersSent) respond(400).end();
      return;
    }
    if (!context.accepting()) return;
    const now = context.now();
    try {
      const result = handleFeishuCallback({
        rawBody: Buffer.concat(chunks),
        headers: {
          timestamp: request.headers["x-lark-request-timestamp"] as string | undefined,
          nonce: request.headers["x-lark-request-nonce"] as string | undefined,
          signature: request.headers["x-lark-signature"] as string | undefined
        },
        verificationToken: context.settings.verificationToken,
        encryptKey: context.settings.encryptKey,
        nowSeconds: Math.floor(now.getTime() / 1000),
        persist: (record) => context.accepting() && context.persist(record, context.memoryDataDir),
        identityNamespace: context.settings.appId
      });
      if (!context.accepting()) return;
      if (result.disposition === "challenge") {
        context.patchStatus({
          status: "ready",
          connected: true,
          authenticated: true,
          listenerReady: true,
          subscriptionVerified: true,
          lastChallengeAt: now.toISOString()
        }, now);
      } else if (result.disposition === "accepted" && result.record) {
        context.patchStatus({
          status: "ready",
          connected: true,
          authenticated: true,
          listenerReady: true,
          subscriptionVerified: true,
          lastMessageAt: now.toISOString(),
          lastEventId: result.record.eventId
        }, now);
        await context.deliver("feishu_message", result.record, {
          feishuChatId: result.record.chatId,
          feishuMessageId: result.record.messageId
        });
      } else if (result.disposition === "duplicate") {
        context.appendLog({
          event: "duplicate_event_ignored",
          message: "Ignored an already persisted Feishu event."
        });
      } else if (result.statusCode >= 400) {
        context.appendLog({
          level: "warning",
          event: "callback_rejected",
          message: `Rejected Feishu callback: ${result.disposition}.`
        });
      }
      respond(result.statusCode, {
        "content-type": "application/json; charset=utf-8"
      });
      response.end(JSON.stringify(result.responseBody ?? {}));
    } catch (error) {
      if (!context.accepting()) return;
      const message = error instanceof Error ? error.message : String(error);
      context.patchStatus({
        status: "failed",
        listenerReady: context.listening(),
        lastError: message,
        message: `飞书回调处理失败：${message}`
      });
      context.appendLog({ level: "error", event: "callback_failed", message });
      if (!response.headersSent) respond(500).end();
    }
  };
}

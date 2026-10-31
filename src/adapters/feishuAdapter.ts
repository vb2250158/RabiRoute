import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import {
  appendAdapterLogToDir,
  appendFeishuMessageToDir,
  type AdapterLogRecord,
  type FeishuMessageRecord
} from "../history.js";
import { forwardMessage } from "../forwarding.js";
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";
import { createFeishuHttpOwner } from "./feishuHttpOwner.js";
import { feishuListenerBinding, createFeishuNativeOperations } from "./platformNativeOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import type { ManagerApiOperationsService } from "../manager/apiOperationContract.js";
import type { ApiExternalListenerPublication, ApiExternalListenerRegistration } from "../manager/apiExternalListenerBinding.js";
import { getGatewayListenerRuntime } from "../runtime/gatewayListenerRuntime.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export { handleFeishuCallback, decryptFeishuCallback, verifyFeishuCallbackSignature,
  type FeishuCallbackHeaders, type FeishuCallbackResult } from "./feishuNativeProtocol.js";

type GatewayStatus = {
  messageAdapters?: Record<string, Record<string, unknown>>;
  feishu?: Record<string, unknown>;
};

function gatewayStatusPath(dataDir: string): string {
  return path.join(dataDir, "gateway-status.json");
}

function patchFeishuStatus(
  patch: Record<string, unknown>,
  dataDir = config.dataDir,
  now = new Date()
): void {
  const statusPath = gatewayStatusPath(dataDir);
  let status: GatewayStatus = {};
  try {
    if (fs.existsSync(statusPath)) {
      status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
    }
  } catch {
    // Replace malformed status while preserving fail-closed runtime behavior.
  }
  const next = {
    ...(status.messageAdapters?.feishu ?? {}),
    ...patch,
    type: "feishu",
    updatedAt: now.toISOString()
  };
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(statusPath, JSON.stringify({
      ...status,
      feishu: { ...status.feishu, ...next },
      messageAdapters: { ...status.messageAdapters, feishu: next }
    }, null, 2), "utf8");
    recordDataMutationAudit({
      group: "gateway",
      event: "feishu_adapter_status_committed",
      owner: "feishu-adapter",
      action: "patch-runtime-status",
      target: { type: "message-adapter", id: "feishu" },
      dataSource: { kind: "runtime", id: "gateway-status" },
      outcome: "committed",
      changes: Object.keys(patch).sort().map(field => ({ field }))
    });
  } catch (error) {
    recordDataMutationAudit({ level: "error", group: "gateway", event: "feishu_adapter_status_write_failed", owner: "feishu-adapter", action: "patch-runtime-status", target: { type: "message-adapter", id: "feishu" }, dataSource: { kind: "runtime", id: "gateway-status" }, outcome: "failed", error });
    throw error;
  }
}

/**
 * Feishu is independent from the generic webhook adapter. The listener stays
 * off until the app credentials, signed callback secrets, and explicit event
 * subscription confirmation are all present.
 */
export type FeishuAdapterSettings = {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  eventSubscriptionEnabled: boolean;
  webhookPath: string;
  webhookPort: number;
  host?: string;
};

export type FeishuAdapterDependencies = {
  settings?: () => FeishuAdapterSettings;
  dataDir?: () => string;
  memoryDataDir?: () => string;
  now?: () => Date;
  createServer?: (requestListener: http.RequestListener) => http.Server;
  persist?: (record: FeishuMessageRecord, memoryDataDir: string) => boolean;
  forward?: (...args: Parameters<typeof forwardMessage>) => unknown | Promise<unknown>;
  apiOperations?: Pick<ManagerApiOperationsService, "registerExternalListener"> | ManagerPluginRouteRegistry;
  publishListener?: (publication: ApiExternalListenerPublication | undefined) => void;
  appendLog?: (
    record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>,
    dataDir: string
  ) => void;
};

type FeishuLifecycle = {
  active: boolean;
  dataDir: string;
  memoryDataDir: string;
  now(): Date;
};

function closeFeishuServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createFeishuAdapter(
  dependencies: FeishuAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "feishu",
    start(): Promise<MessageAdapterDispose> {
      const settings = dependencies.settings?.() ?? {
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        verificationToken: config.feishuVerificationToken,
        encryptKey: config.feishuEncryptKey,
        eventSubscriptionEnabled: config.feishuEventSubscriptionEnabled,
        webhookPath: config.feishuWebhookPath,
        webhookPort: config.feishuWebhookPort
      };
      const lifecycle: FeishuLifecycle = {
        active: true,
        dataDir: dependencies.dataDir?.() ?? config.dataDir,
        memoryDataDir: dependencies.memoryDataDir?.() ?? config.memoryDataDir,
        now: dependencies.now ?? (() => new Date())
      };
      const appendLog = (record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>) => {
        (dependencies.appendLog ?? ((entry, dataDir) => appendAdapterLogToDir("feishu", entry, dataDir)))(record, lifecycle.dataDir);
      };
      const patchRuntimeStatus = (patch: Record<string, unknown>, now = lifecycle.now()) => {
        try {
          patchFeishuStatus(patch, lifecycle.dataDir, now);
        } catch (error) {
          console.error("Failed to update Feishu runtime status", error);
        }
      };
      const appendRuntimeLog = (record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>) => {
        try {
          appendLog(record);
        } catch (error) {
          console.error("Failed to append Feishu runtime log", error);
        }
      };
      const withdrawPublication = () => {
        try { dependencies.publishListener?.(undefined); }
        catch (error) { appendRuntimeLog({ level: "error", event: "listener_publication_withdraw_failed", message: error instanceof Error ? error.message : String(error) }); }
      };
      const missing = [
        !(settings.appId && settings.appSecret) ? "app_credentials" : "",
        !settings.verificationToken ? "verification_token" : "",
        !settings.encryptKey ? "encrypt_key" : "",
        !settings.eventSubscriptionEnabled ? "event_subscription" : ""
      ].filter(Boolean);
      if (missing.length > 0) {
        lifecycle.active = false;
        const message = "飞书消息端保持关闭：需要独立应用凭据、Verification Token、Encrypt Key，并明确确认事件订阅已配置；群机器人 webhook 不能替代。";
        patchFeishuStatus({
          status: "blocked",
          connected: false,
          authenticated: false,
          listenerReady: false,
          message,
          missing
        }, lifecycle.dataDir, lifecycle.now());
        appendLog({
          level: "warning",
          event: "missing_config",
          message,
          data: { missing }
        });
        return Promise.resolve(() => {});
      }

      const persist = dependencies.persist ?? appendFeishuMessageToDir;
      const deliver = dependencies.forward ?? forwardMessage;
      let binding: ApiExternalListenerRegistration | undefined;
      const server = (dependencies.createServer ?? http.createServer)((request, response) => {
        if (!binding) { response.writeHead(503).end(); return; }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!binding.handle(request, url, response)) response.writeHead(404).end();
      });
      const owner = createFeishuHttpOwner({ settings, memoryDataDir: lifecycle.memoryDataDir,
        accepting: () => lifecycle.active, listening: () => server.listening, now: lifecycle.now,
        persist, deliver, patchStatus: patchRuntimeStatus, appendLog: appendRuntimeLog });
      const runtime = dependencies.apiOperations ? undefined : getGatewayListenerRuntime();
      const registry = dependencies.apiOperations ?? { registerExternalListener: (definition: Parameters<ManagerApiOperationsService["registerExternalListener"]>[0]) => runtime!.registerExternalListener("platform.feishu", definition) };

      const host = settings.host || "127.0.0.1";

      return new Promise<MessageAdapterDispose>((resolve, reject) => {
        let startupSettled = false;

        const reportServerError = (error: Error, event: "listen_error" | "server_error") => {
          if (!lifecycle.active && event === "server_error") return;
          const message = event === "listen_error"
            ? `飞书事件入口未启动：${error.message}`
            : `飞书事件入口错误：${error.message}`;
          try {
            patchFeishuStatus({
              status: "failed",
              connected: false,
              authenticated: true,
              listenerReady: false,
              lastError: error.message,
              message
            }, lifecycle.dataDir, lifecycle.now());
          } catch (statusError) {
            console.error("Failed to update Feishu status", statusError);
          }
          try {
            appendLog({ level: "error", event, message });
          } catch (logError) {
            console.error("Failed to append Feishu error log", logError);
          }
        };

        const onStartupError = (error: Error) => {
          if (startupSettled) return;
          startupSettled = true;
          lifecycle.active = false;
          reportServerError(error, "listen_error");
          void closeFeishuServer(server).then(() => reject(error), cleanupError =>
            reject(new AggregateError([error, cleanupError], "Feishu startup and listener cleanup failed.")));
        };

        server.once("error", onStartupError);
        server.listen(settings.webhookPort, host, async () => {
          if (startupSettled) return;
          server.off("error", onStartupError);
          const onServerError = (error: Error) => reportServerError(error, "server_error");
          server.on("error", onServerError);
          try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Feishu listener has no TCP address.");
            const nativeDefinition = feishuListenerBinding(address.port, host);
            const operationId = runtime?.operationId(nativeDefinition.listenerId) ?? nativeDefinition.listenerId;
            const definition = { ...nativeDefinition, listenerId: operationId };
            binding = registry instanceof ManagerPluginRouteRegistry
              ? registry.registerExternalListener("gateway.feishu", definition)
              : registry.registerExternalListener(definition);
            binding.registerHttpProxies(createFeishuNativeOperations(async input => {
              await owner(input.request, input.response, input.prepareResponse);
            }, settings.webhookPath, address.port, operationId));
            dependencies.publishListener?.(binding.publication());
            const message = "飞书独立事件入口已监听，等待已配置的飞书应用完成 URL challenge 或投递事件。";
            patchFeishuStatus({
              status: "listening",
              connected: false,
              authenticated: true,
              listenerReady: true,
              subscriptionVerified: false,
              message,
              callbackPath: settings.webhookPath,
              callbackPort: settings.webhookPort
            }, lifecycle.dataDir, lifecycle.now());
            appendLog({ event: "listening", message });
            startupSettled = true;
            let disposalPromise: Promise<void> | undefined;
            resolve(() => {
              if (!disposalPromise) {
                disposalPromise = (async () => {
                  lifecycle.active = false;
                  server.off("error", onServerError);
                  binding?.stopAccepting();
                  withdrawPublication();
                  const closed = await Promise.allSettled([closeFeishuServer(server), Promise.resolve().then(() => binding?.dispose())]);
                  const errors = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
                  if (errors.length === 1) throw errors[0];
                  if (errors.length) throw new AggregateError(errors, "Feishu listener cleanup failed.");
                  patchRuntimeStatus({
                    status: "disabled",
                    connected: false,
                    authenticated: false,
                    listenerReady: false,
                    subscriptionVerified: false,
                    message: "飞书消息端已停止。",
                    callbackPath: settings.webhookPath,
                    callbackPort: settings.webhookPort
                  });
                  appendRuntimeLog({ event: "disabled", message: "Feishu adapter disabled" });
                })();
              }
              return disposalPromise;
            });
          } catch (error) {
            startupSettled = true;
            lifecycle.active = false;
            server.off("error", onServerError);
            withdrawPublication();
            const closed = await Promise.allSettled([closeFeishuServer(server), Promise.resolve().then(() => binding?.dispose())]);
            const cleanupErrors = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            const startupError = cleanupErrors.length
              ? new AggregateError([error, ...cleanupErrors], "Feishu startup and listener cleanup failed.")
              : error instanceof Error ? error : new Error(String(error));
            reportServerError(startupError, "listen_error");
            reject(startupError);
          }
        });
      });
    }
  };
}

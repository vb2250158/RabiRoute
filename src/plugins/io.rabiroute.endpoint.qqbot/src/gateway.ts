import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "@rabiroute/host-api/shared/filePersistence";
import { once } from "node:events";
import { config, runtimeLayout } from "@rabiroute/host-api/config";
import { appendAdapterLogToDir, appendQqBotMessageToDir, type QqBotMessageRecord } from "@rabiroute/host-api/history";
import { forwardMessage } from "@rabiroute/host-api/forwarding";
import { getGatewayListenerRuntime } from "@rabiroute/host-api/runtime/gatewayListenerRuntime";
import { createBotAccounts } from "./accounts.js";
import { botSigningKey, createBotApi, decodeCallback, qqbotRouteKind } from "./protocol.js";
import { runBotSocket } from "./socket.js";

type GatewaySettings = { dataDir: string; qqbotAccountId?: string; qqbotCallbackPort?: number; qqbotTransport?: "webhook" | "websocket"; qqbotIntents?: number };
type GatewayDependencies = {
  settings: GatewaySettings;
  accounts: () => ReturnType<typeof createBotAccounts>;
  listeners: typeof getGatewayListenerRuntime;
  deliver: typeof forwardMessage;
  gatewayId: () => string;
};

function publishQqBotConnection(dataDir: string, accountId: string, connected: boolean): void {
  const file = path.join(dataDir, "gateway-status.json");
  try {
    const snapshot = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    snapshot.messageAdapters = { ...snapshot.messageAdapters, qqbot: { type: "qqbot", accountId, connected, updatedAt: new Date().toISOString() } };
    atomicWriteFileSync(file, JSON.stringify(snapshot));
  } catch (error) {
    console.error("Failed to publish QQ bot connection", error);
  }
}

export function createQqBotEndpoint(dependencies: GatewayDependencies = {
  settings: config,
  accounts: () => createBotAccounts(runtimeLayout.stateRoot),
  listeners: getGatewayListenerRuntime,
  deliver: forwardMessage,
  gatewayId: () => process.env.GATEWAY_ID!
}) {
  return {
    type: "qqbot",
    async start() {
      const { qqbotAccountId, qqbotCallbackPort, qqbotTransport, qqbotIntents, dataDir } = dependencies.settings;
      if (!qqbotAccountId) return;
      const accounts = dependencies.accounts();
      const listeners = dependencies.listeners();
      const gatewayId = dependencies.gatewayId();
      let currentConnection: boolean | undefined;
      const publishConnection = (connected: boolean) => {
        if (currentConnection === connected) return;
        currentConnection = connected;
        publishQqBotConnection(dataDir, qqbotAccountId, connected);
      };
      const accept = (record: QqBotMessageRecord) => {
        if (appendQqBotMessageToDir(record, dataDir)) dependencies.deliver(qqbotRouteKind(record), record);
      };
      if (qqbotTransport === "websocket") {
        const socketScope = new AbortController();
        publishConnection(false);
        let previousStatus = "";
        const done = runBotSocket({ account: () => accounts.credentials(qqbotAccountId), watchAccount: accounts.observe,
          api: createBotApi(), gatewayId, intents: qqbotIntents ?? 33554432, signal: socketScope.signal, accept,
          report(state, code) {
            const status = state + (code ? " " + code : "");
            if (status === previousStatus) return;
            previousStatus = status;
            if (!socketScope.signal.aborted) publishConnection(state === "ready");
            appendAdapterLogToDir("qqbot", { event: "websocket_" + state, message: status }, dataDir);
          }
        }).catch(() => {
          if (socketScope.signal.aborted) return;
          publishConnection(false);
          appendAdapterLogToDir("qqbot", { level: "error", event: "websocket_failed", message: "QQ 机器人 WebSocket 已退出。" }, dataDir);
        });
        return async () => { socketScope.abort(); await done; };
      }
      publishConnection(false);
      let active = true;
      let key: ReturnType<typeof botSigningKey> | undefined;
      let revision: string | undefined;
      const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
        if (req.method !== "POST" || req.url !== "/qqbot") { res.writeHead(404).end(); return; }
        try {
          const appId = req.headers["x-bot-appid"];
          if (typeof appId !== "string" || !accounts.list().some(account => account.id === qqbotAccountId && account.appId === appId)) {
            res.writeHead(403).end(); return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) { res.writeHead(413, { connection: "close" }).end(); return; }
            chunks.push(chunk);
          }
          if (!active) { res.writeHead(503).end(); return; }
          const account = accounts.credentials(qqbotAccountId);
          if (!account) { res.writeHead(403).end(); return; }
          if (!key || revision !== account.revision) {
            key = botSigningKey(account.appSecret);
            revision = account.revision;
          }
          const result = decodeCallback(Buffer.concat(chunks), {
            appId,
            signature: req.headers["x-signature-ed25519"] as string | undefined,
            timestamp: req.headers["x-signature-timestamp"] as string | undefined
          }, { ...account, key }, gatewayId, Date.now());
          if (result.status !== 200) { res.writeHead(result.status).end(); return; }
          if ("record" in result && result.record) accept(result.record);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result.body));
        } catch {
          if (!res.headersSent) res.writeHead(500).end();
          logFailure("callback_failed", "QQ 机器人回调处理失败。");
        }
      });
      const logFailure = (event: string, message: string) => {
        try { appendAdapterLogToDir("qqbot", { level: "error", event, message }, dataDir); }
        catch { console.error(message); }
      };
      const onError = () => {
        publishConnection(false);
        logFailure("listener_failed", "QQ 机器人回调端口不可用。");
      };
      const publishCallbackAuthorization = () => {
        if (active && server.listening) publishConnection(accounts.list().some(account => account.id === qqbotAccountId && account.state === "connected"));
      };
      const stopWatching = accounts.observe(publishCallbackAuthorization);
      try {
        server.listen(qqbotCallbackPort ?? 0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("QQ Bot callback address is unavailable.");
        const listener = listeners.registerExternalListener("endpoint.qqbot", {
          listenerId: listeners.operationId("qqbot.callback"), address: { protocol: "http", hostname: "127.0.0.1", port: address.port },
          protocol: "qqbot-events-v2", invocation: "discovery-only",
          authentication: { kind: "native", description: "QQ Bot AppID and Ed25519 platform event signatures." }
        });
        server.on("error", onError);
        publishCallbackAuthorization();
        return async () => {
          active = false;
          stopWatching();
          listener.stopAccepting();
          const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          server.closeAllConnections();
          await Promise.all([closing, listener.dispose()]);
        };
      } catch (error) {
        stopWatching();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
      }
    }
  };
}

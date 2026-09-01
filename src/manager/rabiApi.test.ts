import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  handleRabiApi,
  mobileAdapterStates,
  personaProfileIds,
  publicRabiLinkRelayConfig,
  type RabiApiContext
} from "./rabiApi.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

function persona(
  roleId: string,
  displayName: string,
  options: Partial<RouteCatalogPersonaPresentation> = {}
): RouteCatalogPersonaPresentation {
  return {
    rolesRoot: "C:\\roles",
    roleId,
    isPersona: true,
    displayName,
    avatarConfigured: false,
    files: [],
    speech: { voiceReady: false },
    ...options
  };
}

test("Rabi discovery uses only fenced DNS-SD endpoints", () => {
  const source = fs.readFileSync(new URL("./rabiApi.ts", import.meta.url), "utf8");
  assert.match(source, /discoverManagerLanEndpoints/);
  assert.match(source, /verifyManagerDiscoveryEndpoint/);
  assert.match(source, /x-rabiroute-expected-application-generation-id/);
  assert.match(source, /x-rabiroute-expected-manager-instance-id/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /Boolean\(expectedGeneration\) !== Boolean\(expectedManager\)/);
  assert.match(source, /maxResponseBytes = 4 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /function candidateHosts/);
  assert.doesNotMatch(source, /rabiDiscoveryPorts/);
  assert.doesNotMatch(source, /\/api\/rabi\/identity`, timeoutMs/);
});

test("remote Route mutations use only the explicit mutation and generation fence headers", () => {
  const source = fs.readFileSync(new URL("./rabiApi.ts", import.meta.url), "utf8");
  const mutationHeaders = source.slice(
    source.indexOf("function routeMutationProxyHeaders("),
    source.indexOf("function nestedErrorCodes(")
  );
  assert.match(mutationHeaders, /return\s+\{\s*"content-type": "application\/json",\s*"idempotency-key": contract\.operationId,\s*"if-match": contract\.expectedContentHash\s*\}/);
  assert.doesNotMatch(mutationHeaders, /request\.headers|authorization|cookie|x-private|x-rabilink-token/);

  const proxy = source.slice(source.indexOf("async function proxyJson("), source.indexOf("function isSelfGuid("));
  assert.match(proxy, /headers\.set\("x-rabiroute-expected-application-generation-id", instance\.applicationGenerationId\)/);
  assert.match(proxy, /headers\.set\("x-rabiroute-expected-manager-instance-id", instance\.managerInstanceId\)/);
  assert.doesNotMatch(proxy, /request\.headers|authorization|cookie|x-private|x-rabilink-token/);
});

test("public Rabi identity never exposes the Relay application token", () => {
  const publicConfig = publicRabiLinkRelayConfig({
    enabled: true,
    url: "https://relay.example.test",
    token: "secret-app-token",
    deviceId: "pc-test",
    claimWaitMs: 60_000,
    replyIdleTimeoutMs: 60_000,
    speechProxyEnabled: false,
    speechServiceUrl: "http://127.0.0.1:8781"
  });

  assert.equal("token" in publicConfig, false);
  assert.equal(publicConfig.tokenConfigured, true);
  assert.equal(JSON.stringify(publicConfig).includes("secret-app-token"), false);
});

test("mobile persona profiles consume only the immutable child catalog", () => {
  const profiles = personaProfileIds([
    persona("DaiMao", "呆猫"),
    persona("Ilias", "伊莉娅", { avatarConfigured: true, avatarVersion: "1-2" }),
    persona("Momo", "桃子"),
    persona("old", "old", { isPersona: false })
  ], ["Momo"]);
  assert.deepEqual(profiles.map(({ roleId, displayName }) => ({ roleId, displayName })), [
    { roleId: "DaiMao", displayName: "呆猫" },
    { roleId: "Ilias", displayName: "伊莉娅" }
  ]);
});

test("Rabi route presentation has no synchronous roles-root filesystem reads", () => {
  const source = fs.readFileSync(new URL("./rabiApi.ts", import.meta.url), "utf8");
  const presentationSource = source.slice(
    source.indexOf("function routeSummary("),
    source.indexOf("function findGateway(")
  );
  assert.match(presentationSource, /ctx\.routeCatalogPersonas\(\)/);
  assert.match(presentationSource, /personaAvatarFromCatalog/);
  assert.doesNotMatch(presentationSource, /fs\.|personaAvatarPresentation|readdirSync|statSync|readFileSync/);
});

test("mobile adapter states distinguish independent login and connection state", () => {
  const states = mobileAdapterStates({
    enabled: true,
    running: true,
    messageAdapters: ["napcat", "weixin", "rabilink"],
    runtimeStatus: {
      gatewayStatus: {
        napcatInstances: {
          primary: { connected: true, botUserId: "private-account-id" }
        },
        messageAdapters: {
          weixin: {
            status: "running",
            loggedIn: false,
            accountId: "private-weixin-id",
            lastError: "private diagnostic detail"
          }
        }
      }
    }
  });

  assert.deepEqual(states, [
    { type: "napcat", label: "QQ", state: "connected", summary: "已连接" },
    { type: "weixin", label: "个人微信", state: "login_required", summary: "未登录" },
    { type: "rabilink", label: "手机消息", state: "ready", summary: "已就绪" }
  ]);
  const serialized = JSON.stringify(states);
  assert.equal(serialized.includes("private-account-id"), false);
  assert.equal(serialized.includes("private-weixin-id"), false);
  assert.equal(serialized.includes("diagnostic"), false);
});

test("mobile adapter states describe stopped or disabled entries without reporting a system fault", () => {
  assert.deepEqual(mobileAdapterStates({
    enabled: true,
    running: false,
    messageAdapters: ["napcat", "weixin"]
  }).map(({ state, summary }) => ({ state, summary })), [
    { state: "stopped", summary: "等待 Rabi PC 启动" },
    { state: "stopped", summary: "等待 Rabi PC 启动" }
  ]);

  assert.deepEqual(mobileAdapterStates({
    enabled: true,
    running: true,
    messageAdapters: ["napcat", "weixin"],
    messageAdaptersDisabled: ["weixin"]
  }).map(({ state, summary }) => ({ state, summary })), [
    { state: "waiting", summary: "等待 QQ 连接" },
    { state: "disabled", summary: "已停用" }
  ]);
});

test("agent binding enforces strong mutation fencing and returns replayable committed receipts", async (t) => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  let currentHash = hashA;
  let commitCount = 0;
  let config = {
    gateways: [{
      id: "route-a",
      name: "Route A",
      configName: "route-a",
      enabled: true,
      messageAdapters: ["rabilink"],
      agentAdapters: ["codex"]
    }]
  } as any;
  const receipts = new Map<string, { digest: string; hash: string }>();
  const context = {
    rootDir: process.cwd(),
    routeRoot: process.cwd(),
    managerPort: 0,
    managerHost: "127.0.0.1",
    applicationGenerationId: "generation-test",
    managerInstanceId: "manager-test",
    version: () => "test",
    globalConfig: {
      configPath: "C:\\private\\rabi.json",
      read: () => ({ rabiGuid: "self-guid", rabiName: "Rabi Test", rabiLinkRelay: {} }),
      patch: () => { throw new Error("not used"); }
    },
    runtimes: () => [],
    runtimeStatus: () => ({}),
    readConfig: () => structuredClone(config),
    writeConfig: async (next: any, expectedContentHash: string | undefined, operationId: string) => {
      const digest = JSON.stringify(next);
      const receipt = receipts.get(operationId);
      if (receipt) {
        if (receipt.digest !== digest) {
          throw Object.assign(new Error("raw private path must not escape: C:\\private\\route.json"), {
            statusCode: 503,
            code: "route_catalog_unavailable",
            cause: Object.assign(new Error("idempotency conflict"), { code: "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT" })
          });
        }
        return structuredClone(config);
      }
      if (expectedContentHash !== currentHash) {
        throw Object.assign(new Error("raw private path must not escape: C:\\private\\route.json"), {
          statusCode: 409,
          code: "route_catalog_conflict",
          cause: Object.assign(new Error("revision conflict"), { code: "ROUTE_CATALOG_REVISION_CONFLICT" })
        });
      }
      commitCount += 1;
      config = structuredClone(next);
      currentHash = hashB;
      receipts.set(operationId, { digest, hash: currentHash });
      return structuredClone(config);
    },
    loadRuntimes: async () => {},
    routeCatalogVersion: () => ({
      contentHash: currentHash,
      routeConfigHash: currentHash,
      presentationHash: "c".repeat(64),
      revision: commitCount
    }),
    routeCatalogPersonas: () => [],
    syncRunningGateways: () => {},
    syncRabiLinkRelay: async () => {},
    scanAgentAdapters: async () => ({}),
    routeDataDir: () => process.cwd()
  } as unknown as RabiApiContext;

  const server = http.createServer((request, response) => {
    const handled = handleRabiApi(request, new URL(request.url || "/", "http://127.0.0.1"), response, context);
    if (!handled) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/api/rabi/instances/self-guid/routes/route-a/agent-binding`;
  const requestBinding = (operationId: string, expectedContentHash: string, codexThreadName: string) => fetch(endpoint, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-rabiroute-expected-application-generation-id": "generation-test",
      "x-rabiroute-expected-manager-instance-id": "manager-test",
      "idempotency-key": operationId,
      "if-match": expectedContentHash
    },
    body: JSON.stringify({ agentAdapter: "codex", codexThreadName })
  });

  const first = await requestBinding("binding-operation-a", hashA, "thread-a");
  assert.equal(first.status, 200);
  const firstBody = await first.json() as any;
  assert.deepEqual(firstBody.receipt, {
    state: "committed",
    operationId: "binding-operation-a",
    routeConfigHash: hashB
  });
  assert.equal(firstBody.routeCatalog.routeConfigHash, hashB);

  const replay = await requestBinding("binding-operation-a", hashA, "thread-a");
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as any).receipt.operationId, "binding-operation-a");
  assert.equal(commitCount, 1, "same-key replay after a lost response must not create a second storage commit");

  const stale = await requestBinding("binding-operation-b", hashA, "thread-b");
  assert.equal(stale.status, 412);
  const staleBody = await stale.json() as any;
  assert.equal(staleBody.errorCode, "route_catalog_conflict");
  assert.equal(JSON.stringify(staleBody).includes("C:\\private"), false);
  assert.equal(commitCount, 1);

  const conflictingReplay = await requestBinding("binding-operation-a", hashA, "different-thread");
  assert.equal(conflictingReplay.status, 409);
  const conflictBody = await conflictingReplay.json() as any;
  assert.equal(conflictBody.errorCode, "route_catalog_idempotency_conflict");
  assert.equal(JSON.stringify(conflictBody).includes("C:\\private"), false);
  assert.equal(commitCount, 1);

  const missingHeaders = await fetch(endpoint, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentAdapter: "codex" })
  });
  assert.equal(missingHeaders.status, 400);

  const weakLocal = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "binding-operation-weak-local",
      "if-match": `W/"${hashB}"`
    },
    body: JSON.stringify({ agentAdapter: "codex", codexThreadName: "weak-local" })
  });
  assert.equal(weakLocal.status, 428, "a weak If-Match validator must not be laundered into a strong local precondition");
  assert.equal((await weakLocal.json() as any).errorCode, "route_catalog_precondition_required");
  assert.equal(commitCount, 1);

  const remoteEndpoint = `http://127.0.0.1:${port}/api/rabi/instances/remote-guid/routes/route-a/agent-binding`;
  const weakRemote = await fetch(remoteEndpoint, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "binding-operation-weak-remote",
      "if-match": `W/"${hashB}"`
    },
    body: JSON.stringify({ agentAdapter: "codex", codexThreadName: "weak-remote" })
  });
  assert.equal(weakRemote.status, 428, "remote proxying must reject weak If-Match before discovery or forwarding");
  assert.equal((await weakRemote.json() as any).errorCode, "route_catalog_precondition_required");
  assert.equal(commitCount, 1);
});

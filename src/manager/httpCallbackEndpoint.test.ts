import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("callback diagnostics require the current native lease and never fabricate a saved or zero port", () => {
  const source = fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
  const original = source.match(/function routeCallbackEndpoint\([\s\S]*?\n\}/)?.[0];
  assert.ok(original);
  const compiled = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const descriptor = { pid: 123, gatewayGenerationId: "generation", leaseId: "lease", address: { hostname: "127.0.0.1", port: 34567 }, assertCurrent() {} };
  let current: typeof descriptor | undefined = descriptor;
  const status = { pid: 123, gatewayGenerationId: "generation", messageAdapters: {
    rabilink: { listenerReady: true, listenerLeaseId: "lease" } }, httpCallbacks: { rabilink: { path: "/rabilink", url: "http://127.0.0.1:1/retired" } } };
  const context = vm.createContext({ gatewayListenerPublicationHost: { readListener: () => current }, readGatewayStatus: () => status,
    callbackUrlForCopy: (url: string) => url, sanitizeConfigName: (name: string) => name, routeRuntimeParts: () => ({ configName: "route" }) });
  vm.runInContext(`${compiled.outputText}; globalThis.read = routeCallbackEndpoint;`, context);
  const read = context.read as (runtime: unknown, type: string) => { url: string; healthy: boolean } | null;
  const runtime = { definition: { id: "route", configName: "route", rabiLinkWebhookPort: 0 } };
  assert.equal(read(runtime, "rabilink")?.url, "http://127.0.0.1:34567/rabilink");
  current = undefined; assert.equal(read(runtime, "rabilink"), null);
  current = descriptor; status.messageAdapters.rabilink.listenerLeaseId = "retired";
  assert.equal(read(runtime, "rabilink"), null);
  status.messageAdapters.rabilink.listenerLeaseId = "lease"; status.httpCallbacks.rabilink.path = "/old-path";
  assert.equal(read(runtime, "rabilink"), null);
  status.httpCallbacks.rabilink.path = "/rabilink"; status.messageAdapters.rabilink.listenerReady = false;
  assert.equal(read(runtime, "rabilink"), null);
});

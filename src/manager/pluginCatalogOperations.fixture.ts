import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile, type HostService } from "../plugin-kernel/index.js";
import { renderPluginCatalog } from "./pluginCatalogPresentation.js";
import { createPluginCatalogOperations } from "./pluginCatalogOperations.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { PluginCatalogApiContext, PluginCatalogInvocation } from "./pluginCatalogRoutes.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real temporary packages, native runtime, file registry, credentials and HTTP ingress. */
export async function pluginCatalogFixture(t: TestContext, options: {
  readOnly?: boolean;
  ingress?: "agent" | "webgui";
  configure?(context: PluginCatalogApiContext): void;
  deadlineMs?: number;
  hostServices?: readonly HostService[];
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-catalog-operations-"));
  const packageRoot = path.join(root, "packages"), runtimeRoot = path.join(root, "runtime");
  const packageDirectory = path.join(packageRoot, "io.test.catalog", "1.0.0"), profilePath = path.join(root, "profile.json");
  await fs.mkdir(path.join(packageDirectory, "web", "nested"), { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.catalog", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" }, web: { execution: "in_process", module: "./web/nested/client.mjs" } },
    provides: ["test.catalog@1"], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(packageDirectory, "manager.mjs"), `export function activate(context) {
    context.services.provide("test.catalog@1", { ready: true });
    context.contributions.register({ kind: "navigation", id: "catalog", value: { hosts: ["web"], label: "fixture" } });
  }`);
  const source = Buffer.from("export const value = '字节';\r\n");
  await fs.writeFile(path.join(packageDirectory, "web", "nested", "client.mjs"), source);
  await fs.writeFile(path.join(packageDirectory, "web", "theme.css"), "body { color: red; }\n");
  await fs.writeFile(path.join(packageDirectory, "web", "data.bin"), Buffer.from([0, 255, 128, 42]));
  const profile = { schemaVersion: 2, readyRequires: [], instances: [{ id: "manager:catalog", package: "io.test.catalog", version: "1.0.0", enabled: true, config: {}, grants: [] }] };
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const catalog = new PluginPackageCatalog([packageRoot], { trustedInProcessRoots: [packageRoot] });
  const runtime = new GenerationRuntime({ host: "manager", hostServices: options.hostServices,
    applicationIdentity: { applicationGenerationId: "fixture-application", managerInstanceId: "fixture-manager" } });
  const modules = new WebPluginModuleRegistry();
  let count = 0, tail: Promise<unknown> = Promise.resolve();
  const reconcile = (invocation?: PluginCatalogInvocation) => {
    const work = tail.then(async () => {
      invocation?.assertCurrent();
      const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot, host: "manager" });
      invocation?.assertCurrent(); count++;
      const result = await runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires,
        ...(invocation ? { beforePublish: () => invocation.assertCurrent() } : {}) });
      modules.update(loaded, result.generation);
      invocation?.assertCurrent();
      return result.generation;
    });
    tail = work.catch(() => undefined);
    return work;
  };
  await reconcile();
  const context: PluginCatalogApiContext = {
    runtime, root: () => root,
    renderCatalog: async (input, host) => ({ revision: 19, contract: {}, value: renderPluginCatalog(input, host) }),
    reconciliation: { diagnostics: () => runtime.current().records.filter(record => record.status !== "active" || record.error), reconcile },
    webModules: { list: () => modules.list(), read: (id, rev, relativePath) => modules.read(id, rev, relativePath) }
  };
  options.configure?.(context);
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createPluginCatalogOperations(context, options.readOnly).map(definition => options.deadlineMs
    ? { ...definition, contract: { ...definition.contract, request: { ...definition.contract.request, deadlineMs: options.deadlineMs } } } : definition);
  const registration = registry.registerOperations("fixture:catalog", definitions);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "unbound-computer");
  const headers = { authorization: `Bearer ${credential.token}` };
  const server = http.createServer((request, response) => {
    if (options.ingress === "webgui") {
      const lease = authority.acquireConnectionLease(credential.token);
      if (request.headers.authorization !== headers.authorization || !lease) { response.writeHead(403).end(); return; }
      markAuthenticatedConnectionRequest(request, () => authority.assertConnectionLease(credential.token, lease));
    } else {
      const admission = evaluateLanAgentRequest(request, authority, true);
      if (admission.kind !== "agent") { response.writeHead(403).end(); return; }
    }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture did not listen.");
  t.after(async () => {
    server.closeAllConnections();
    await registration.dispose(); await tail; await runtime.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, packageDirectory, profilePath, profile, runtime, context, modules, registry, registration, authority, definitions,
    source, headers, baseUrl: `http://127.0.0.1:${address.port}`, count: () => count,
    fetch: (route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${route}`, { ...init, headers: { ...headers, ...init.headers } }),
    blockQueue: (barrier: Promise<void>) => { tail = tail.then(() => barrier); }, reconcile };
}

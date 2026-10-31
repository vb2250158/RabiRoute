import { LAN_AGENT_MANAGEMENT_ROUTES } from "./lanAgentManagementContract.js";
import { LAN_AGENT_READ_ROUTES } from "./lanAgentReadOperations.js";
import { LAN_AGENT_INTERACTIVE_ROUTES } from "./lanAgentInteractiveContract.js";
import { REMOTE_AGENT_ROUTES } from "./remoteAgentContract.js";
import { CODEX_HOOK_OPERATIONS, codexHookOperationContract } from "./codexHookContract.js";
import { qqReadOperationContract } from "./qqReadContract.js";
import { qqStickerOperationContract } from "./qqStickerContract.js";
import { createAgentReceiptMaintenanceOperations } from "./agentSendReceiptOperations.js";
import { agentUploadOperationContract } from "./agentUploadContract.js";
import { createAgentDeliveryRecordOperations } from "./agentDeliveryRecords.js";
import { createAgentThreadControlOperations } from "./agentThreadControlOperations.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { listAgentApiOperations, validateAgentApiRequestTarget } from "./agentApiPolicy.js";

function sample(template: string): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "uploadId") return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    if (name === "date") return "2026-01-02";
    if (name === "historyJobId") return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    if (name === "mediaId") return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    return "example-id";
  });
}

test("migrated persona resources, storage, identity and health have no legacy duplicates", () => {
  const retired = new Set(["chat-history", "voice-transcripts", "conversation-situations", "persona-document", "persona-reference", "skills", "message-endpoint-history", "plan-agents/status", "plans", "memory", "counts", "plan-statuses", "plan-marker-statuses", "identity-relations", "identity-participants", "identity-endpoint-accounts", "identity-candidates", "voice-identities", "health", "knowledge-validation", "knowledge"]);
  for (const operation of listAgentApiOperations()) {
    const suffix = operation.pathTemplate.replace(/^\/(?:api\/)?roles\/:roleId\//, "");
    assert.ok(![...retired].some(value => suffix === value || suffix.startsWith(value + "/")), operation.id);
  }
  // Native response coverage and remote success are verified by the executable-owner suites.
});

test("migrated home, speech and video discovery no longer has a second legacy table", () => {
  const legacy = listAgentApiOperations();
  assert.ok(!legacy.some(operation => operation.pathTemplate.startsWith("/api/agent/xiaomi-home") || operation.pathTemplate.startsWith("/api/speech/") || operation.pathTemplate.startsWith("/api/video/")));
  // Native authority, platform validation and successful remote calls are exercised by the executable owner suites.
});

test("discovery exposes immutable contracts without enforcing a second feature policy", () => {
  const catalog = listAgentApiOperations();
  assert.ok(Array.isArray(catalog));
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  assert.equal(new Set(catalog.map(item => `${item.method} ${item.pathTemplate}`)).size, catalog.length);
  assert.ok(Object.isFrozen(catalog));
  for (const operation of catalog) {
    assert.ok(Object.isFrozen(operation));
    assert.ok(Object.isFrozen(operation.queryParameters));
    assert.ok(Object.isFrozen(operation.repeatableQueryParameters));
    assert.ok(Object.isFrozen(operation.limitations));
    assert.ok(Object.isFrozen(operation.help));
    assert.ok(Object.isFrozen(operation.help.request));
    assert.ok(Object.isFrozen(operation.help.errors));
    assert.equal(operation.help.operationId, operation.id);
    assert.equal(operation.help.method, operation.method);
    assert.equal(operation.help.pathTemplate, operation.pathTemplate);
    assert.ok(operation.help.nextStep.length > 0);
    const verified = operation.id.startsWith("desktop-pet:") || ["agent:POST:/api/agent/send", "agent:PUT:/api/agent/uploads/:uploadId", "agent:GET:/api/agent/uploads/:uploadId", "home:POST:/api/agent/xiaomi-home/action-requests", "agent:GET:/api/agent/qq/diagnostics", "agent:GET:/api/agent/qq/group-files", "agent:POST:/api/agent/send/receipts/:deliveryId/verify", "agent:POST:/api/agent/send/receipts/:deliveryId/settle"].includes(operation.id);
    assert.equal(operation.help.auth.required, verified ? true : null);
    assert.ok(Object.isFrozen(operation.help.auth.scopes));
    assert.equal(operation.help.effects.mode, verified ? (operation.method === "GET" || operation.pathTemplate.endsWith("/verify") ? "readOnly" : "mutating") : "unknown");
    assert.equal(operation.help.idempotency.required, verified ? operation.method !== "GET" : null);
    assert.ok(operation.description.length > 0);
    assert.equal(operation.contractResourceId, "docs/rabi-agent-interfaces.md");
    assert.equal(operation.help.contractLevel, "baseline");
    assert.equal(operation.help.auditLevel, verified ? "implementation-summary" : "none");
    if (!verified && operation.method !== "GET") assert.match(operation.help.request.body, /尚未在 Help 核验/);
    assert.equal(operation.help.coverage.exactRequestSchema, false);
    assert.equal(operation.help.coverage.exactResponseSchema, false);
    if (operation.help.machineReadable) {
      assert.equal(operation.pathTemplate, "/api/agent/uploads/:uploadId");
      assert.deepEqual(operation.help.coverage.missing, operation.help.machineReadable.missing);
      assert.ok(operation.help.coverage.missing.includes("error-response-schemas"));
    } else assert.deepEqual(operation.help.coverage.missing, ["request-body-schema", "response-schema"]);

  }
  assert.throws(() => Object.assign(catalog[0], { pathTemplate: "/api/webgui-access" }));
});

test("legacy discovery entries retain declaration or executable-owner source evidence, not runtime coverage", () => {
  const root = new URL("../../plugins/builtin/", import.meta.url);
  const declarations: { kind: string; path: string; methods?: string[] }[] = [];
  let managerFiles = 0;
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!entry.replaceAll("\\", "/").endsWith("/manager.mjs")) continue;
    managerFiles++;
    const source = fs.readFileSync(new URL(entry.replaceAll("\\", "/"), root), "utf8");
    const ast = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const literal = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && !node.properties.some(ts.isSpreadAssignment)) {
        const fields = new Map<string, ts.Expression>();
        for (const field of node.properties) {
          if (!ts.isPropertyAssignment(field)) continue;
          const name = ts.isIdentifier(field.name) ? field.name.text : literal(field.name);
          if (name) fields.set(name, field.initializer);
        }
        const kind = literal(fields.get("kind"));
        const routePath = literal(fields.get(kind === "prefix" ? "pathPrefix" : "path"));
        const methodsNode = fields.get("methods");
        const methods = methodsNode && ts.isArrayLiteralExpression(methodsNode) ? methodsNode.elements.map(literal) : undefined;
        if (literal(fields.get("routeId")) && (kind === "exact" || kind === "prefix") && routePath
          && (!methodsNode || (methods && methods.every((method): method is string => method !== undefined)))) {
          declarations.push({ kind, path: routePath, methods: methods as string[] | undefined });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.ok(managerFiles > 0, "The inventory must read actual Manager plugin sources; migrated routes do not need legacy declarations.");
  const executableRoutes = [...LAN_AGENT_MANAGEMENT_ROUTES, ...LAN_AGENT_READ_ROUTES.map(route => ({ ...route, method: "GET" })),
    ...createAgentDeliveryRecordOperations({ agentRequests: new AgentRequestStore({ read: () => undefined, write: () => { throw new Error("Inventory cannot write"); } }) }).map(operation => operation.contract),
    ...createAgentThreadControlOperations({ prepare: () => { throw new Error("Inventory cannot execute owner actions"); } }).map(operation => operation.contract),
    ...LAN_AGENT_INTERACTIVE_ROUTES, ...REMOTE_AGENT_ROUTES,
    ...CODEX_HOOK_OPERATIONS.map(codexHookOperationContract), ...(["history", "message", "attachment"] as const).map(qqReadOperationContract),
    ...[false, true].map(qqStickerOperationContract), ...createAgentReceiptMaintenanceOperations({}).map(operation => operation.contract),
    ...(["GET", "PUT"] as const).map(method => agentUploadOperationContract(method, Number.MAX_SAFE_INTEGER))];
  // Compatibility inventory only. Real dispatch/ownership is exercised by executable HTTP
  // and compiled-Manager tests; source presence cannot prove full-project coverage.
  const executableOwnerSources = ["apiDiscoveryRoutes", "corePublicOperations", "agentSendOperations", "agentSendReceiptOperations",
    "agentCommunicationRecordOperations", "agentChatHistoryOperation", "codexHookContract", "agentAdapterCatalogContract",
    "agentUploadRoutes", "agentQqDiagnostics", "agentGroupFiles", "resourceApiContract", "webguiAccessOperations"]
    .map(name => fs.readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"));
  executableOwnerSources.push(fs.readFileSync(new URL("../../plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/operations.mjs", import.meta.url), "utf8"));
  const missingSources: string[] = [];
  for (const operation of listAgentApiOperations()) {
    const path = sample(operation.pathTemplate);
    if (!(executableRoutes.some(route => route.pathTemplate === operation.pathTemplate && route.method === operation.method)
      || executableOwnerSources.some(source => source.includes(JSON.stringify(operation.pathTemplate)))
      || declarations.some(route => (route.kind === "exact" ? route.path === path : path.startsWith(route.path))
        && (!route.methods || route.methods.includes("*") || route.methods.includes(operation.method))))) missingSources.push(operation.id);
  }
  assert.deepEqual(missingSources, [], "Legacy inventory entries need a declaration or their executable owner source.");
});

test("authenticated ingress accepts public endpoints independently of the discovery catalog", () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    for (const target of ["/api/extension/future?option=value", "/manager-config", "/api/roles/example/plans"])
      assert.equal(validateAgentApiRequestTarget(method, target).allowed, true);
});

test("ingress retains HTTP target parsing and credential transport checks", () => {
  for (const target of ["http://localhost/meta", "//localhost/meta", "meta", "/meta#fragment", "/api/../meta", "/api/%2e%2e/meta", "/api/a%2fb", "/meta?query=%ff", "/meta?query=%00"])
    assert.equal(validateAgentApiRequestTarget("GET", target).allowed, false, target);
  for (const key of ["token", "access_token", "Authorization", "api-key", "cookie", "password"])
    assert.deepEqual(validateAgentApiRequestTarget("GET", `/meta?${key}=fake`), { allowed: false, reason: "query_credentials" });
});

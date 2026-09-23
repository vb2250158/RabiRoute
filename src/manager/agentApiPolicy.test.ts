import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { authorizeAgentApiOperation as authorize, listAgentApiOperations } from "./agentApiPolicy.js";

function sample(template: string): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "uploadId") return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    if (name === "date") return "2026-01-02";
    if (name === "historyJobId") return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    if (name === "mediaId") return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    return "example-id";
  });
}

test("discovery and enforcement share one immutable catalog with discoverable contracts", () => {
  const catalog = listAgentApiOperations();
  assert.ok(catalog.length > 150);
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
    const verified = ["agent:POST:/api/agent/send", "agent:PUT:/api/agent/uploads/:uploadId", "agent:GET:/api/agent/uploads/:uploadId", "home:POST:/api/agent/xiaomi-home/action-requests"].includes(operation.id);
    assert.equal(operation.help.auth.required, verified ? true : null);
    assert.ok(Object.isFrozen(operation.help.auth.scopes));
    assert.equal(operation.help.effects.mode, verified ? (operation.method === "GET" ? "readOnly" : "mutating") : "unknown");
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
    const decision = authorize(operation.method, sample(operation.pathTemplate));
    assert.equal(decision.allowed, true, operation.id);
    if (decision.allowed) assert.equal(decision.operation.id, operation.id);
    assert.equal(authorize(operation.method, `${sample(operation.pathTemplate)}/unexpected/action`).allowed, false, operation.id);
    assert.equal(authorize(operation.method, `${sample(operation.pathTemplate)}?__unknown=example`).allowed, false, operation.id);
  }
  assert.throws(() => Object.assign(catalog[0], { pathTemplate: "/api/webgui-access" }));
});

test("every catalog operation has declaration-level dispatch coverage, not handler verification", () => {
  const root = new URL("../../plugins/builtin/", import.meta.url);
  const declarations: { kind: string; path: string; methods?: string[] }[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!entry.replaceAll("\\", "/").endsWith("/manager.mjs")) continue;
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
  assert.ok(declarations.length > 50);
  for (const operation of listAgentApiOperations()) {
    const path = sample(operation.pathTemplate);
    assert.ok(declarations.some(route => (route.kind === "exact" ? route.path === path : path.startsWith(route.path))
      && (!route.methods || route.methods.includes("*") || route.methods.includes(operation.method))), operation.id);
  }
});

test("core business operations are allowed with their exact methods", () => {
  const allowed: [string, string][] = [
    ["GET", "/meta"],
    ["GET", "/api/roles/example/plans?limit=10&status=active&status=waiting&tag=one&tag=two"],
    ["POST", "/api/roles/example/plans"],
    ["PATCH", "/roles/example/plans/plan-1"],
    ["POST", "/api/roles/example/plans/plan-1/feedback"],
    ["DELETE", "/api/roles/example/plan-statuses/retired"],
    ["GET", "/api/roles/example/plan-agents/status?planId=p1&planId=p2"],
    ["POST", "/roles/example/memory/consolidation-runs/run-1/result"],
    ["GET", "/api/roles/example/skills/skill-1"],
    ["GET", "/api/roles/%E4%BA%BA%E6%A0%BC/knowledge/search?query=%E8%AE%A1%E5%88%92+update&mode=fulltext"],
    ["GET", "/api/roles/example/message-endpoint-history?conversationKey=napcat%3Agroup%3Aexample&query=token"],
    ["POST", "/api/agent/threads"],
    ["POST", "/api/agent/send"],
    ["POST", "/api/agent/requests/request-1/cancel"],
    ["POST", "/api/message-processing/requirements/request-1/knowledge-callback"],
    ["POST", "/api/message-processing/requirements/request-1/send-context"],
    ["PUT", "/api/roles/example/identity-relations"],
    ["PATCH", "/api/roles/example/health/config"],
    ["POST", "/api/personas/example/messages"],
    ["POST", "/api/speech/tts"],
    ["POST", "/api/speech/asr"],
    ["GET", "/api/speech/records/record-1/audio"],
    ["POST", "/api/remote-agent/tasks"],
    ["GET", "/api/bilibili-history/roles/example/days/2026-01-02?limit=10"],
    ["POST", "/api/video/jobs"],
    ["POST", "/api/agent/yeyu-gamer/work-items"],
    ["POST", "/api/agent/xiaomi-home/action-requests"]
  ];
  for (const [method, target] of allowed) assert.equal(authorize(method, target).allowed, true, `${method} ${target}`);
});

test("generic Codex hooks cannot forge another session or replace the principal-bound LAN hook", () => {
  assert.equal(listAgentApiOperations().some(operation => operation.pathTemplate.startsWith("/api/codex-hook")), false);
  for (const suffix of ["context", "roles", "doctor", "sessions", "sessions/example-session"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const decision = authorize(method, `/api/codex-hook/${suffix}`);
      assert.deepEqual(decision, { allowed: false, reason: "operation_not_allowed" });
    }
  }
  // This catalog must not grant the special endpoint without the caller's exact node/Agent check.
  assert.equal(authorize("POST", "/api/lan-agent/instances/example-node/agents/example-agent/context").allowed, false);
});

test("administration, credentials, arbitrary files and unsupported methods fail closed", () => {
  const targets = [
    "/api/agent/copilot-install", "/api/agent/copilot-login", "/api/agent/astrbot-login-test",
    "/api/agent/marvis-open", "/api/agent/xiaomi-home/auth", "/api/agent/xiaomi-home/auth/refresh",
    "/api/agent/xiaomi-home/settings", "/api/agent/xiaomi-home/artifacts",
    "/api/webgui-access", "/manager-config", "/reload", "/open-config-file",
    "/api/plugins/reconciliation", "/api/lan-agent/nodes/example/update", "/api/lan-agent/connect",
    "/api/roles/example/config", "/api/roles/example/personaConfig.json", "/roles/example/persona.md",
    "/api/persona-sync/files/example/secret.json", "/api/persona-sync/merge",
    "/api/speech/audio-streams/token", "/api/speech/model-management/runtime/install",
    "/api/speech/model-management/settings", "/api/speech/model-management/models/example/install",
    "/api/speech/runtime/start", "/api/video/models/runtime", "/api/video/models/example/download",
    "/api/remote-agent/connect", "/api/remote-agent/task-events", "/api/bilibili-history/bridge/pair",
    "/api/bilibili-history/bridge/next", "/api/language-style/validate", "/api/role-panel/messages",
    "/api/unknown", "/api/host/quit", "/api/agent/threads/anything"
  ];
  for (const target of targets) {
    // Artifact listing is business; registration takes a local filesystem path and is deliberately absent.
    const methods = target === "/api/agent/xiaomi-home/artifacts" ? ["POST", "PUT", "DELETE"] : ["GET", "POST", "PATCH", "PUT", "DELETE"];
    for (const method of methods) assert.equal(authorize(method, target).allowed, false, `${method} ${target}`);
  }
  for (const method of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "get", " GET", "POST ", "GET\r\n"]) {
    assert.deepEqual(authorize(method, "/meta"), { allowed: false, reason: "invalid_method" });
  }
  assert.equal(authorize("DELETE", "/api/roles/example/plans/plan-1").allowed, false);
  assert.equal(authorize("PATCH", "/api/roles/example/memory/consolidated/memory-1").allowed, false);
  assert.equal(authorize("POST", "/api/roles/example/skills").allowed, false);
  assert.equal(authorize("GET", "/api/roles/example/plan-statuses/status-1").allowed, false);
});

test("raw path and encoding attacks cannot normalize into an allowed operation", () => {
  for (const target of [
    "http://localhost/meta", "//localhost/meta", "meta", "/meta/", "/meta#fragment", "/meta\\x",
    "/api//agent/threads", "/api/agent/./threads", "/api/x/../agent/threads",
    "/api/%61gent/threads", "/api/agent/%74hreads", "/API/agent/threads",
    "/api/roles/../plans", "/api/roles/%2e%2e/plans", "/api/roles/%252e%252e/plans",
    "/api/roles/a%2fb/plans", "/api/roles/a%5cb/plans", "/api/roles/a%252fb/plans",
    "/api/roles/a%00/plans", "/api/roles/a%0d/plans", "/api/roles/a%7f/plans",
    "/api/roles/%ff/plans", "/api/roles/%C0%AF/plans", "/api/roles/%E0%A4/plans",
    "/api/roles/%u002e/plans", "/api/roles/%/plans", "/api/roles/a%3Ab/plans",
    "/api/roles/a%3fb/plans", "/api/roles/a%23b/plans", "/api/roles/a;b/plans",
    "/api/roles/a./plans", "/api/roles/a%20/plans", "/api/roles/CON/plans",
    "/api/roles/.hidden/plans", "/api/roles/a\u0000/plans", "/api/roles/a b/plans",
    "/api/roles/\ud800/plans", "/api/roles/" + "a".repeat(513) + "/plans"
  ]) assert.equal(authorize("GET", target).allowed, false, JSON.stringify(target));
  assert.equal(authorize("GET", "/meta?query=" + "a".repeat(16_384)).allowed, false);
});

test("query credentials and query-based file or method bypasses are denied", () => {
  for (const key of ["token", "access_token", "Authorization", "api-key", "cookie", "clientSecret", "password", "sourceCapability", "%74oken", "X%2DApi%2DKey"]) {
    assert.deepEqual(authorize("GET", `/api/roles/example/plans?${key}=fake`), { allowed: false, reason: "query_credentials" });
  }
  for (const query of [
    "path=example", "file=other.md", "url=http%3A%2F%2Flocalhost", "_method=DELETE", "method=POST",
    "query=one&query=two", "limit=10&limit=20", "to%256ben=fake", "token[]=fake",
    "query=%ff", "query=%", "query=%00", "query=%0d%0a", "query=x&&limit=1", "query=x;token=fake&unknown=x",
    "limit", "=x", "", "query=x&", "q=x&".repeat(129)
  ]) assert.equal(authorize("GET", `/api/roles/example/plans?${query}`).allowed, false, query);
  assert.equal(authorize("GET", "/api/roles/example/persona-document?file=other.md").allowed, false);
  assert.equal(authorize("GET", "/api/roles/example/plans?query=credential+discussion").allowed, true);
});

test("constrained integrations retain exact ID shapes and existing loopback limitations", () => {
  assert.equal(authorize("GET", "/api/bilibili-history/roles/example/days/not-a-date").allowed, false);
  assert.equal(authorize("GET", "/api/bilibili-history/jobs/not-hex").allowed, false);
  assert.equal(authorize("GET", "/api/video/jobs/not-a-media-id").allowed, false);
  for (const target of ["/api/agent/xiaomi-home/resources", "/api/agent/yeyu-gamer/snapshot"]) {
    const decision = authorize("GET", target);
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.ok(decision.operation.limitations.some(value => value.includes("loopback")));
  }
});

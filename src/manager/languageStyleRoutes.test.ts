import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanguageStyleValidator, LANGUAGE_STYLE_VALIDATION_LIMITS } from "../languageStyleValidation.js";
import { createLanguageStyleOperations } from "./languageStyleRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

test("Manager language style API returns pass or fail with reasons", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-style-api-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir())); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const skillDir = path.join(rootDir, "style");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "references", "style-data.json"), JSON.stringify({
    runtimeConstraints: {
      checks: [{
        id: "API-001",
        level: "error",
        scope: ["final"],
        kind: "forbidden_phrases",
        values: ["一句话总结"],
        message: "删除套话。"
      }]
    }
  }), "utf8");
  const validator = new LanguageStyleValidator();
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("persona", createLanguageStyleOperations(validator));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!registry.handle(request, requestUrl, response)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/language-style/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "一句话总结。", styleSkillUrl: skillDir, scope: "final" })
  });
  const payload = await response.json() as { code: number; data: { passed: boolean; violations: Array<{ ruleId: string }> } };
  assert.equal(response.status, 200);
  assert.equal(payload.code, 0);
  assert.equal(payload.data.passed, false);
  assert.equal(payload.data.violations[0]?.ruleId, "API-001");
  const invoke = (body: unknown, contentType = "application/json") => fetch(`http://127.0.0.1:${address.port}/api/language-style/validate`, {
    method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body)
  });
  const normalized = await invoke({ text: " ".repeat(200010) + "正常。", styleSkillUrl: skillDir, scope: null, prompt: { original: "coercion" }, extension: true }, "text/plain");
  assert.equal(normalized.status, 200); assert.equal((await normalized.json()).data.scope, LANGUAGE_STYLE_VALIDATION_LIMITS.defaultScope);
  const unavailable = await invoke({ text: "正常。", styleSkillUrl: path.join(rootDir, "absent-style"), scope: "final" });
  assert.equal(unavailable.status, 200); assert.equal((await unavailable.json()).data.status, "unavailable");
  assert.equal((await invoke({ text: "   ", styleSkillUrl: skillDir })).status, 400);
  assert.equal((await invoke({ text: "normal", styleSkillUrl: skillDir, extension: "x".repeat(LANGUAGE_STYLE_VALIDATION_LIMITS.requestBytes) })).status, 413);
  assert.equal(registry.catalogSnapshot().operations[0].contract.request.body.kind, "json");
});

test("authenticated nodes use native style validation without an Agent registration and cannot disclose after original revocation", { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "style-operation-node-"));
  const style = path.join(root, "style"); fs.mkdirSync(path.join(style, "references"), { recursive: true });
  fs.writeFileSync(path.join(style, "references/style-data.json"), JSON.stringify({ runtimeConstraints: { checks: [
    { id: "AUTH-ONLY-RULE", level: "error", kind: "forbidden_phrases", values: ["protected phrase"], message: "fixture violation" }
  ] } }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "style-node");
  const native = new LanguageStyleValidator(); let gate: Promise<void> | undefined, entered: (() => void) | undefined, release: (() => void) | undefined;
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("persona", createLanguageStyleOperations({ validate: async request => {
    entered?.(); if (gate) await gate; return native.validate(request);
  } }));
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { release?.(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const invoke = () => fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/language-style/validate`, {
    method: "POST", headers: { authorization: "Bearer " + credential.token, "content-type": "application/json" }, body: JSON.stringify({ text: "protected phrase", styleSkillUrl: style, scope: "final" }), signal: AbortSignal.timeout(5000)
  });
  const first = await invoke(); assert.equal(first.status, 200); assert.equal((await first.json()).data.violations[0].ruleId, "AUTH-ONLY-RULE");
  const reached = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
  const pending = invoke(); await reached; authority.setNodeEnabled(credential.nodeId, false, true); authority.setNodeEnabled(credential.nodeId, true, false); release!();
  const revoked = await pending; assert.equal(revoked.status, 403); assert.ok(!(await revoked.text()).includes("AUTH-ONLY-RULE"));
});

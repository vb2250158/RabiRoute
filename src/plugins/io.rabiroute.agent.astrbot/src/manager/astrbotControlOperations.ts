import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import type { AstrbotLoginTestRequest } from "@rabiroute/host-api/agentAdapters/managerTypes";
import { createAgentProviderControlOperationContract as contract, type AstrbotLoginTestResult } from "@rabiroute/host-api/shared/agentProviderControlContract";
const json = (schema: Record<string, unknown>) => ({ mediaType: "application/json", schema });
export function createAstrbotControlOperations(testLogin: (request: AstrbotLoginTestRequest) => Promise<AstrbotLoginTestResult>): readonly ApiOperationDefinition[] {
  const descriptor = contract("manager.agent.astrbot.login-test", "POST", "/api/agent/astrbot-login-test", "Verify AstrBot Dashboard login with the original login owner and read its project/session discovery; no prompt is sent.",
    { "200": json({ type: "object", additionalProperties: false, required: ["ok", "status", "message"], properties: { ok: { const: true }, status: { type: "integer", minimum: 0 }, message: { type: "string" } } }),
      "400": json({ type: "object", additionalProperties: false, required: ["ok", "message"], properties: { ok: { const: false }, status: { type: "integer", minimum: 0 }, message: { type: "string" } } }) },
    { mode: "account-login-check", description: "Use the original Dashboard auth/login request and subsequent read-only project/session requests. The transient native token is used internally and is never part of this API response. The operation lease joins those native requests after HTTP disconnect." },
    { strategy: "inspect-login-result", description: "Read the native ok/status/message result. Timeout or failure does not authorize automatic prompt delivery or account reconfiguration; no idempotency key or persisted delivery receipt exists." });
  return [{ contract: { ...descriptor, request: { ...descriptor.request, body: { kind: "json", maxBytes: 0, allowAnyContentType: true, schema: { type: "object", additionalProperties: true,
    properties: { url: { type: ["string", "null"], description: "Existing Dashboard URL; empty/null/absent follows native environment/default resolution." }, username: { type: ["string", "null"] }, password: { type: ["string", "null"], writeOnly: true } } } } } },
    handler: async input => { try { input.signal?.throwIfAborted(); const result = await testLogin(input.body as AstrbotLoginTestRequest); return { status: result.ok ? 200 : 400, body: result }; }
      catch (error) { return { status: 400, body: { ok: false, message: error instanceof Error ? error.message : String(error) } }; } } }];
}

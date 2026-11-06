import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { createAgentProviderControlOperationContract as contract, type CopilotControlOperationsContext, type CopilotLoginResult } from "@rabiroute/host-api/shared/agentProviderControlContract";
const json = (schema: Record<string, unknown>) => ({ mediaType: "application/json", schema });
const failure = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: false }, error: { type: "string" }, stderr: { type: "string" } } };
function loginResult(result: CopilotLoginResult): ApiOperationResult {
  if (result.kind === "device-code") return { status: 200, body: { ok: true, code: result.code, url: result.url, ...(result.pid === undefined ? {} : { pid: result.pid }) } };
  if (result.kind === "completed") return { status: 200, body: { ok: true, done: true } };
  if (result.kind === "timeout") return { status: 408, body: { ok: false, error: result.error || "Timeout waiting for device code" } };
  return { status: 500, body: { ok: false, error: result.error } };
}
export function createCopilotControlOperations(context: CopilotControlOperationsContext): readonly ApiOperationDefinition[] {
  return [{ contract: contract("manager.agent.copilot.install", "POST", "/api/agent/copilot-install", "Install the existing global Copilot CLI package through its native process owner.",
    { "200": json({ type: "object", additionalProperties: false, required: ["ok", "stdout", "stderr"], properties: { ok: { const: true }, stdout: { type: "string" }, stderr: { type: "string" } } }), "500": json(failure) },
    { mode: "global-package-install", description: "Run the native npm global installation once, with its existing 120-second process timeout; wait for actual process and stdio close before completing or retiring." },
    { strategy: "inspect-installation-no-replay", receiptPath: "/api/agent/copilot-status", description: "No idempotency key exists. Inspect the installed CLI status after timeout or failure before another explicit install request; do not automatically replay a global installation." }, true),
    handler: async input => { try { input.signal?.throwIfAborted(); const { stdout = "", stderr = "" } = await context.installCopilot(); return { status: 200, body: { ok: true, stdout: stdout.trim(), stderr: stderr.trim() } }; }
      catch (error) { const detail = error as { message?: string; stderr?: string }; return { status: 500, body: { ok: false, ...(detail?.message === undefined ? {} : { error: detail.message }), ...(detail?.stderr === undefined ? {} : { stderr: detail.stderr }) } }; } } },
  { contract: contract("manager.agent.copilot.login", "POST", "/api/agent/copilot-login", "Start the original Copilot CLI login; a returned device code is a pending login, not an authenticated account.",
    { "200": json({ oneOf: [{ type: "object", additionalProperties: false, required: ["ok", "code", "url"], properties: { ok: { const: true }, code: { type: "string" }, url: { type: ["string", "null"] }, pid: { type: "integer", minimum: 1 } } }, { type: "object", additionalProperties: false, required: ["ok", "done"], properties: { ok: { const: true }, done: { const: true } } }] }), "408": json(failure), "500": json(failure) },
    { mode: "account-login", description: "The original owner starts Copilot login. Device-code acknowledgement leaves that child running under the same owner; final native close emits copilot_login_status. Plugin retirement stops and joins it before release." },
    { strategy: "inspect-login-no-replay", receiptPath: "/api/agent/copilot-status", description: "Inspect native login status and the original pending device-code interaction before another explicit login. No request idempotency key exists. A 15-second device-code timeout terminates and joins the original process; no automatic second login." }, true),
    handler: async input => { try { input.signal?.throwIfAborted(); return loginResult(await context.startCopilotLogin({ onExit: status => context.publishEvent("copilot_login_status", status) })); }
      catch (error) { return { status: 500, body: { ok: false, error: String(error) } }; } } },
  { contract: contract("manager.agent.copilot.status", "GET", "/api/agent/copilot-status", "Read the existing Copilot executable discovery and local login-state owner without starting login.",
    { "200": json({ type: "object", additionalProperties: false, required: ["installed", "binPath", "loggedIn", "copilotHome"], properties: { installed: { type: "boolean" }, binPath: { type: "string" }, loggedIn: { type: "boolean" }, copilotHome: { type: "string" } } }), "500": json(failure) },
    { mode: "read", description: "Read native executable discovery and existing Copilot home login files; does not install packages, log in or execute prompts." },
    { strategy: "repeatable-read", description: "Read the same native status again. A discovered executable or saved login flag does not prove a new Agent prompt was executed." }),
    handler: async () => { try { return { status: 200, body: await context.getCopilotStatus() }; } catch (error) { return { status: 500, body: { ok: false, error: String(error) } }; } } }];
}

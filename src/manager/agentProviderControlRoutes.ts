import type { AstrbotLoginTestRequest } from "../agentAdapters/managerApi.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

export type CopilotInstallResult = { stdout?: string; stderr?: string };
export type CopilotLoginExitStatus = { done: boolean; exitCode: number | null; error: string };
export type CopilotLoginResult =
  | { kind: "device-code"; code: string; url: string | null; pid?: number }
  | { kind: "completed" }
  | { kind: "timeout"; error?: string }
  | { kind: "failed"; error: string };
export type AstrbotLoginTestResult = Record<string, unknown> & { ok: boolean };
export type CopilotControlOperationsContext = {
  installCopilot(): Promise<CopilotInstallResult>;
  startCopilotLogin(callbacks: { onExit(status: CopilotLoginExitStatus): void }): Promise<CopilotLoginResult>;
  getCopilotStatus(): Promise<Record<string, unknown>>;
  publishEvent(eventType: string, data: unknown): void;
};
const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const json = (schema: Record<string, unknown>) => ({ mediaType: "application/json", schema });
const failure = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: false }, error: { type: "string" }, stderr: { type: "string" } } };
function contract(operationId: string, method: "GET" | "POST", pathTemplate: string, description: string,
  responses: ApiOperationContract["responses"], effects: ApiOperationContract["effects"], recovery: ApiOperationContract["recovery"], allowIgnoredBody = false): ApiOperationContract {
  return { operationId, aliases: [`agent:${method}:${pathTemplate}`], contractVersion: "1.0.0", method, pathTemplate, description,
    exposure: "public", transport: "http", request: { path: empty, query: ignored, headers: ignored, body: { kind: "none", ...(allowIgnoredBody ? { allowIgnoredBody: true } : {}) } }, responses, effects, recovery,
    validators: [{ id: "native-provider-owner", description: "Use the original provider owner and native environment/path defaults. An authenticated enabled remote connection needs no extra feature grant, persona or Route binding. Unknown query fields are ignored." }] };
}
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

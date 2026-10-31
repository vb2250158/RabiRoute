import { NapcatLifecycleError } from "../shared/napcatStateContract.js";
import type { ApiOperationDefinition, ApiOperationInput, ApiSchema } from "./apiOperationContract.js";
import type { NapcatHealthRequest, NapcatLaunchRequest, NapcatLoginActionRequest, NapcatLoginPanelRequest, NapcatStopRequest } from "../messageEndpoints/napcatManager.js";
export type { NapcatHealthRequest, NapcatLaunchRequest, NapcatLoginActionRequest, NapcatLoginPanelRequest } from "../messageEndpoints/napcatManager.js";
export type NapcatAddRequest = { gatewayId?: string };
export type NapcatRemoveRequest = NapcatStopRequest;
export type NapcatControlResult = Record<string, unknown> & { ok?: unknown };
type MaybePromise<T> = T | Promise<T>;
export type NapcatControlRoutesContext = {
  assertCurrent?: () => void;
  repairAll: () => MaybePromise<NapcatControlResult>;
  ensureReady: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  health: (request: NapcatHealthRequest) => MaybePromise<NapcatControlResult>;
  loginPanel: (request: NapcatLoginPanelRequest) => MaybePromise<NapcatControlResult>;
  loginAction: (request: NapcatLoginActionRequest) => MaybePromise<NapcatControlResult>;
  configureOneBot: (request: NapcatHealthRequest) => MaybePromise<NapcatControlResult>;
  add: (request: NapcatAddRequest) => MaybePromise<NapcatControlResult>;
  launch: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  restart: (request: NapcatLaunchRequest) => MaybePromise<NapcatControlResult>;
  remove: (request: NapcatRemoveRequest) => MaybePromise<NapcatControlResult>;
};
const ignored = { type: "object" } as const;
const empty = { type: "object", additionalProperties: false } as const;
const resultSchema = { type: "object", additionalProperties: true, description: "The original NapCat owner result, including its extensible health, login, process and repair diagnostics. Native truthiness of ok determines the HTTP status for applicable actions." } as const;
const errorSchema = { type: "object", required: ["ok", "message"], additionalProperties: false, properties: { ok: { const: false }, message: { type: "string" }, state: { type: "string" } } } as const;
const nativeInput = (fields: readonly string[]): ApiSchema => ({
  description: "Native JSON input is deliberately permissive: the original owner validates and coerces selectors and action-specific values. Unknown fields are ignored; null and scalar values retain native behavior. No credential or login payload is persisted by the contract.",
  anyOf: [{ type: "object", additionalProperties: true, properties: Object.fromEntries(fields.map(field => [field, { description: "Consumed by the original native NapCat owner when applicable; retain native validation and coercion." }])) }, { not: { type: "object" } }]
});
const bindingFields = ["gatewayId", "instanceId"];
const launchFields = [...bindingFields, "forceRestart", "visible"];
const healthFields = [...bindingFields, "httpUrl", "webuiUrl", "accessToken", "webuiToken", "gatewayPort", "readWebuiLoginInfo", "inspectProcesses", "requireWsConnection", "botUserId", "botNickname"];
type Action = { suffix: string; key: keyof Omit<NapcatControlRoutesContext, "assertCurrent">; fields: readonly string[]; status: "always" | "not-false" | "truthy"; noStore?: boolean; description: string };
const actions: readonly Action[] = [
  { suffix: "repair-all", key: "repairAll", fields: [], status: "always", description: "Repair all configured native NapCat instances; ignore every request body without decoding it." },
  { suffix: "ensure-ready", key: "ensureReady", fields: [...launchFields, "requireWsConnection"], status: "always", description: "Ask the bound native NapCat owner to ensure readiness, retaining binding locks and supervisor rules." },
  { suffix: "health", key: "health", fields: healthFields, status: "always", description: "Inspect native NapCat health; inspection may contact the configured HTTP/WebUI endpoints and inspect processes." },
  { suffix: "login-panel", key: "loginPanel", fields: bindingFields, status: "always", noStore: true, description: "Read the native managed login panel and original account state without caching its response." },
  { suffix: "login-action", key: "loginAction", fields: [...bindingFields, "userId", "action", "password", "ticket", "randstr", "sid", "newDevicePullQrCodeSig", "jumpUrl", "bytesToken"], status: "not-false", noStore: true, description: "Submit an action to the original managed login owner. The owner validates quick-login, refresh-qr, password-login, captcha-login, new-device-login, new-device-qr and new-device-poll." },
  { suffix: "configure-onebot", key: "configureOneBot", fields: healthFields, status: "truthy", description: "Configure native OneBot connectivity using the original instance owner." },
  { suffix: "add", key: "add", fields: ["gatewayId"], status: "truthy", description: "Add a managed NapCat instance through the original Manager configuration owner." },
  { suffix: "launch", key: "launch", fields: launchFields, status: "not-false", description: "Launch the bound native NapCat process under the original binding and lifecycle rules." },
  { suffix: "restart", key: "restart", fields: launchFields, status: "truthy", description: "Restart the original managed NapCat instance through its binding lock and native process owner." },
  { suffix: "remove", key: "remove", fields: [...bindingFields, "name", "gatewayPort", "httpUrl", "webuiUrl", "accessToken", "webuiToken", "launchCommand", "workingDir"], status: "truthy", description: "Remove a managed NapCat instance through its original stop and configuration owner." }
];

/** Routing, discovery and decoding share these definitions; native owners retain all business actions. */
export function createNapcatControlOperations(context: NapcatControlRoutesContext): readonly ApiOperationDefinition[] {
  return actions.map(action => {
    const headers = action.noStore ? { "cache-control": "no-store" } : undefined;
    const execute = async (input: ApiOperationInput) => {
      try {
        context.assertCurrent?.();
        input.signal?.throwIfAborted();
        const native = context[action.key] as (body: unknown) => MaybePromise<NapcatControlResult>;
        const body = await native(input.body);
        const success = action.status === "always" || (action.status === "not-false" ? body.ok !== false : Boolean(body.ok));
        return { status: success ? 200 : 400, body, headers };
      } catch (error) {
        return { status: 400, headers, body: { ok: false, message: error instanceof Error ? error.message : String(error), ...(error instanceof NapcatLifecycleError ? { state: error.state } : {}) } };
      }
    };
    return { contract: {
      operationId: `manager.napcat.${action.suffix}`, contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/message/napcat-${action.suffix}`, exposure: "public", transport: "http", description: action.description,
      request: { path: empty, query: ignored, headers: ignored, body: action.key === "repairAll" ? { kind: "none", allowIgnoredBody: true } : { kind: "json", schema: nativeInput(action.fields), maxBytes: 0, emptyValue: {}, allowAnyContentType: true } },
      responses: { "200": { mediaType: "application/json", schema: resultSchema }, "400": { mediaType: "application/json", schema: { anyOf: [resultSchema, errorSchema] } } },
      effects: { mode: action.key === "health" || action.key === "loginPanel" ? "native-inspection" : "native-napcat-control", description: "The existing Manager/NapCat owners retain configuration, binding locks, account checks, external requests, process ownership and durable diagnostics. A successful HTTP result is not independent proof of login or message delivery." },
      recovery: { strategy: "inspect-native-state-no-replay", receiptPath: "/api/message/napcat-health", description: "No request-level idempotency or operation receipt exists. After an uncertain mutation, inspect the original bound instance and configuration; do not automatically replay login, add, remove, repair or process actions. Plugin retirement stops admission and joins supervisor and real in-flight actions; bound processes survive Manager handover." },
      validators: [{ id: "native-napcat-owner", description: "Native request validation and response truthiness are retained, including NapcatLifecycleError.state, no-store login responses, ignored repair-all bytes and existing unbounded JSON input. Authenticated remote connections need no additional feature grant." }]
    }, prepare: () => { context.assertCurrent?.(); return execute; }, handler: execute };
  });
}

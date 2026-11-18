import { compileApiContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { contractFor, ManagementError, callNapcatWebuiManagement as call, checkNapcatWebuiManagementAccount as account, napcatWebuiDigest as digest, selectNapcatWebuiManagementInstance, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { napcatWebauthnAssertionSchema, napcatWebauthnPublicOptionsSchema, projectNapcatWebauthnPublicOptions } from "./napcatWebuiAuthContracts.js";
import { napcatApiFailure } from "./napcatApiTransport.js";
const sourceLocations: Record<string, {
    route: number;
    handlers: number[];
}> = {
    "POST /api/auth/passkey/generate-authentication-options": { "route": 89282, "handlers": [89226] }, "POST /api/auth/passkey/generate-registration-options": { "route": 89280, "handlers": [89192] }, "POST /api/auth/passkey/verify-authentication": { "route": 89283, "handlers": [89241] }, "POST /api/auth/passkey/verify-registration": { "route": 89281, "handlers": [89205] }, "POST /api/auth/update_token": { "route": 89279, "handlers": [89151] }
};
type Row = Record<string, unknown>;
const text = {
    type: "string", minLength: 1, maxLength: 256
}, empty = {
    type: "object", additionalProperties: false, properties: {}
}, responseRef = {
    type: "object", additionalProperties: false, required: ["response"], properties: { response: napcatWebauthnAssertionSchema }
};
const actions = [
    {
        id: "passkey.authentication.options", path: "generate-authentication-options", params: empty
    }, {
        id: "passkey.registration.options", path: "generate-registration-options", params: empty
    }, {
        id: "passkey.authentication.verify", path: "verify-authentication", params: responseRef
    }, {
        id: "passkey.registration.verify", path: "verify-registration", params: responseRef
    }, {
        id: "session.token.rotate", path: "update_token", params: {
            type: "object", additionalProperties: false, required: ["newToken"], properties: { newToken: {
                    type: "string", minLength: 6, maxLength: 4096, pattern: "^(?=.*[A-Za-z])(?=.*[0-9])\\S(?:[\\s\\S]*\\S)?$", writeOnly: true
                } }
        }
    }
];
export const napcatWebuiAuthNativeActions = actions.map(spec => ({
    id: spec.id, method: "POST" as const, nativePath: spec.id === "session.token.rotate" ? "/api/auth/update_token" : "/api/auth/passkey/" + spec.path
}));
export function createNapcatWebuiAuthOperations(context: NapcatWebuiManagementContext): readonly ApiOperationDefinition[] {
    return actions.map(spec => {
        const contract = contractFor({
            id: spec.id, method: "POST", nativePath: spec.id === "session.token.rotate" ? "/api/auth/update_token" : "/api/auth/passkey/" + spec.path, params: spec.params, response: {
                type: "object", additionalProperties: false, properties: {
                    publicKey: napcatWebauthnPublicOptionsSchema, verified: { type: "boolean" }, authenticated: { type: "boolean" }, changed: { type: "boolean" }, configurationOperationId: text, configurationRevision: text, workflow: { enum: ["original-native-origin-webauthn", "original-native-token-source-and-config-owner"] }
                }
            }, binding: "management-bootstrap", effects: "configuration-mutation", description: "Original native WebAuthn challenge/verification. Only standard public WebAuthn options leave the owner. Assertions and new tokens stay in transient request memory; Credential stays in the only original WebUI session cache. Requires an authenticator assertion for the original native origin/RP, never a forged caller Origin header. Receipt acknowledgements do not claim browser or hardware acceptance.", sourceLines: sourceLocations[spec.id === "session.token.rotate" ? "POST /api/auth/update_token" : "POST /api/auth/passkey/" + spec.path] ?? { route: 0, handlers: [] }
        }), compiled = compileApiContract({ contract });
        return {
            contract, discovery: { title: `NapCat ${spec.id}`, category: { id: "qq-webui", title: "QQ / NapCat management" } }, handler: async (input) => {
                try {
                    if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.path ?? {}).length || Object.keys(input.query ?? {}).length || !compiled.bodyValidator?.(input.body))
                        throw new ManagementError("PARAMETERS_INVALID", 400);
                    if (context.readOnly())
                        throw new ManagementError("READ_ONLY", 403);
                    if (spec.id === "session.token.rotate" && !context.prepareWebuiToken)
                        throw new ManagementError("TOKEN_CONFIGURATION_OWNER_UNAVAILABLE", 409);
                    const body = input.body as {
                        routeId: string;
                        instanceId: string;
                        params: Row;
                        deliveryId?: string;
                    }, signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
                    const binding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal), session = await context.openManagementSession(binding, signal);
                    await account(session, binding, signal);
                    if (spec.id === "session.token.rotate" && !session.runTokenRotation)
                        throw new ManagementError("TOKEN_ROTATION_OWNER_UNAVAILABLE", 409);
                    let assertAuthority = binding.assertCurrent;
                    const run = spec.id === "session.token.rotate" ? session.runTokenRotation!.bind(session) : session.runBindingOperation.bind(session);
                    const outcome = await run(() => executeDurableDelivery({
                        rootDir: context.rootDir, namespace: "napcat-webui-management-v1", deliveryId: body.deliveryId, payload: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId, paramsDigest: digest(body.params)
                        }, audit: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId
                        }, requestAuthority: () => assertAuthority(), deliver: async () => {
                            await account(session, binding, signal);
                            let params: Row = {};
                            if (spec.id === "session.token.rotate") {
                                const newToken = String(body.params.newToken);
                                const operationId = "napcat-token-" + digest([
                                    body.routeId, body.instanceId, body.deliveryId
                                ]);
                                const prepared = await context.prepareWebuiToken!(binding, operationId);
                                await call(session, binding, "POST", "/api/auth/update_token", { newToken }, signal);
                                const committed = await prepared.commit(newToken);
                                if (committed.operationId !== operationId)
                                    throw new ManagementError("TOKEN_CONFIGURATION_OPERATION_MISMATCH");
                                // The original CAS owner supplies the replacement admission fence even for an uncertain CAS.
                                // Subsequent failures can retain the original receipt without re-authorizing an obsolete snapshot.
                                assertAuthority = committed.assertCurrent;
                                if (committed.state !== "committed")
                                    throw new ManagementError("TOKEN_CONFIGURATION_UNCERTAIN");
                                const current = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal);
                                if (current.expectedUserId !== binding.expectedUserId)
                                    throw new ManagementError("ACCOUNT_MISMATCH", 409);
                                const replacement = await context.openManagementSession(current, signal);
                                await account(replacement, current, signal);
                                const persistedFence = committed.assertCurrent;
                                assertAuthority = () => {
                                    persistedFence();
                                    current.assertCurrent();
                                    replacement.assertCurrent();
                                };
                                assertAuthority();
                                return {
                                    changed: true, configurationOperationId: operationId, configurationRevision: committed.revision, workflow: "original-native-token-source-and-config-owner"
                                };
                            }
                            if (body.params.response)
                                params = { response: body.params.response };
                            const value = await call(session, binding, "POST", "/api/auth/passkey/" + spec.path, params, signal);
                            await account(session, binding, signal);
                            if (spec.path.startsWith("generate-")) {
                                const data = { publicKey: projectNapcatWebauthnPublicOptions(value), workflow: "original-native-origin-webauthn" };
                                if (!compiled.responseValidators.get("200")?.[0]?.body?.({ code: 0, data }))
                                    throw new ManagementError("WEBAUTHN_OPTIONS_INVALID");
                                return data;
                            }
                            if (!value || typeof value !== "object" || (spec.path === "verify-authentication" ? (value as Row).authenticated !== true : (value as Row).verified !== true))
                                throw new ManagementError("WEBAUTHN_VERIFICATION_FAILED");
                            return spec.path === "verify-authentication" ? { authenticated: true, workflow: "original-native-origin-webauthn" } : { verified: true, workflow: "original-native-origin-webauthn" };
                        }
                    }));
                    if (outcome.state === "conflict")
                        throw new ManagementError("DELIVERY_CONFLICT", 409);
                    return outcome.state === "completed" ? { status: 200, body: {
                            code: 0, data: outcome.result, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate
                            }
                        } } : { status: 202, body: { code: 0, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, retryable: false
                            } } };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            }
        };
    });
}

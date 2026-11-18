import { compileApiContract, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { contractFor } from "./napcatWebuiManagementOperations.js";
const base64 = {
    type: "string", minLength: 1, maxLength: 1048576
}, optionalBase64 = { type: ["string", "null"], maxLength: 1048576 };
export const napcatWebauthnAssertionSchema: ApiSchema = {
    type: "object", additionalProperties: false, required: [
        "id", "rawId", "type", "response"
    ], properties: {
        id: base64, rawId: base64, type: { const: "public-key" }, authenticatorAttachment: { enum: [
                "platform", "cross-platform", null
            ] }, clientExtensionResults: { type: "object", maxProperties: 64 }, response: {
            type: "object", additionalProperties: false, required: ["clientDataJSON"], properties: {
                clientDataJSON: base64, authenticatorData: base64, signature: base64, userHandle: optionalBase64, attestationObject: base64, transports: {
                    type: "array", maxItems: 16, items: { type: "string" }
                }, publicKey: base64, publicKeyAlgorithm: { type: "integer" }
            }
        }
    }
};
const schema: ApiSchema = {
    type: "object", additionalProperties: false, required: ["response"], properties: { response: napcatWebauthnAssertionSchema }
};
const publicText = {
    type: "string", minLength: 1, maxLength: 65536
};
const publicCredential = {
    type: "object", additionalProperties: false, required: ["id", "type"], properties: {
        id: publicText, type: { const: "public-key" }, transports: { type: "array", items: { type: "string" } }
    }
};
export const napcatWebauthnPublicOptionsSchema: ApiSchema = {
    type: "object", additionalProperties: false, required: ["challenge"], properties: {
        challenge: publicText, rpId: publicText, timeout: { type: "integer", minimum: 0 }, attestation: { enum: [
                "none", "indirect", "direct", "enterprise"
            ] },
        rp: {
            type: "object", additionalProperties: false, properties: { id: publicText, name: publicText }
        },
        user: {
            type: "object", additionalProperties: false, properties: {
                id: publicText, name: publicText, displayName: publicText
            }
        },
        pubKeyCredParams: { type: "array", items: {
                type: "object", additionalProperties: false, required: ["type", "alg"], properties: { type: { const: "public-key" }, alg: { type: "integer" } }
            } },
        allowCredentials: { type: "array", items: publicCredential }, excludeCredentials: { type: "array", items: publicCredential },
        authenticatorSelection: {
            type: "object", additionalProperties: false, properties: {
                authenticatorAttachment: { enum: ["platform", "cross-platform"] }, residentKey: { enum: [
                        "discouraged", "preferred", "required"
                    ] }, requireResidentKey: { type: "boolean" }, userVerification: { enum: [
                        "discouraged", "preferred", "required"
                    ] }
            }
        },
        extensions: {
            type: "object", additionalProperties: false, properties: {
                credProps: { type: "boolean" }, minPinLength: { type: "boolean" }, hmacCreateSecret: { type: "boolean" }
            }
        }
    }
};
/** Only standard public WebAuthn options leave this owner; Credential/token/private-key fields cannot ride along. */
export function projectNapcatWebauthnPublicOptions(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("NAPCAT_WEBAUTHN_OPTIONS_INVALID");
    const input = value as Record<string, unknown>, output: Record<string, unknown> = {};
    for (const key of [
        "challenge", "rpId", "timeout", "attestation"
    ])
        if (input[key] !== undefined)
            output[key] = input[key];
    const pick = (source: unknown, keys: string[]) => {
        if (!source || typeof source !== "object" || Array.isArray(source))
            throw new Error("NAPCAT_WEBAUTHN_OPTIONS_INVALID");
        return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, (source as Record<string, unknown>)[key]]));
    };
    for (const [key, fields] of Object.entries({
        rp: ["id", "name"], user: [
            "id", "name", "displayName"
        ], authenticatorSelection: [
            "authenticatorAttachment", "residentKey", "requireResidentKey", "userVerification"
        ], extensions: [
            "credProps", "minPinLength", "hmacCreateSecret"
        ]
    }))
        if (input[key] !== undefined)
            output[key] = pick(input[key], fields);
    for (const [key, fields] of Object.entries({
        allowCredentials: [
            "id", "type", "transports"
        ], excludeCredentials: [
            "id", "type", "transports"
        ], pubKeyCredParams: ["type", "alg"]
    }))
        if (input[key] !== undefined) {
            if (!Array.isArray(input[key]))
                throw new Error("NAPCAT_WEBAUTHN_OPTIONS_INVALID");
            output[key] = (input[key] as unknown[]).map(item => pick(item, fields));
        }
    return output;
}
const contract = contractFor({
    id: "passkey-validator", method: "POST", nativePath: "/api/auth/passkey/verify-authentication", params: schema, response: { type: "object" }, binding: "management-bootstrap", effects: "none", description: "Native WebAuthn assertion input", sourceLines: { route: 0, handlers: [] }
});
const validate = compileApiContract({ contract: { ...contract, request: { ...contract.request, body: {
                kind: "json", maxBytes: 1048576, schema
            } } } }).bodyValidator;
export function assertNapcatWebuiAuthRequest(method: string, pathname: string, body: Record<string, unknown>): boolean {
    if (method !== "POST")
        return false;
    if (pathname === "/api/auth/update_token") {
        if (Object.keys(body).some(k => k !== "newToken") || typeof body.newToken !== "string" || body.newToken.length < 6 || body.newToken.length > 4096 || !/[a-z]/i.test(body.newToken) || !/[0-9]/.test(body.newToken))
            throw new Error("NAPCAT_WEBUI_AUTH_REQUEST_INVALID");
        return true;
    }
    if (["/api/auth/passkey/generate-authentication-options", "/api/auth/passkey/generate-registration-options"].includes(pathname)) {
        if (Object.keys(body).length)
            throw new Error("NAPCAT_WEBUI_AUTH_REQUEST_INVALID");
        return true;
    }
    if (["/api/auth/passkey/verify-authentication", "/api/auth/passkey/verify-registration"].includes(pathname)) {
        if (!validate?.(body))
            throw new Error("NAPCAT_WEBUI_AUTH_REQUEST_INVALID");
        return true;
    }
    return false;
}

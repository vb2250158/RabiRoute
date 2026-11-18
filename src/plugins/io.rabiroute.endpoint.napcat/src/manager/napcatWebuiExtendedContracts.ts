import type { ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { compileApiContract } from "@rabiroute/host-api/manager/apiOperationContract";
import type { NapcatWebuiManagementDescriptor } from "./napcatWebuiManagementContracts.js";
import { contractFor } from "./napcatWebuiManagementOperations.js";
import { napcatWebuiObjectReferenceSchema } from "./napcatWebuiResources.js";
const text = {
    type: "string", minLength: 1, maxLength: 256
} as const;
const pluginId = { ...text, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" };
const bool = { type: "boolean" } as const;
const object = (properties: Record<string, ApiSchema>, required: string[] = []) => ({
    type: "object", additionalProperties: false, properties, required
}) as ApiSchema;
const acknowledgement = object({
    accepted: { const: true }, nativeReadback: bool, afterDigest: { type: "string" }, restartRequired: bool
}, ["accepted", "nativeReadback"]);
const config = object({
    fileLog: bool, consoleLog: bool, fileLogLevel: { enum: [
            "debug", "info", "warn", "error"
        ] }, consoleLogLevel: { enum: [
            "debug", "info", "warn", "error"
        ] },
    packetBackend: text, packetServer: { type: "string", maxLength: 4096 }, o3HookMode: { type: "number" }, autoTimeSync: bool,
    bypass: object(Object.fromEntries([
        "hook", "window", "module", "process", "container", "js"
    ].map(key => [key, bool])))
});
const webuiConfig = object({
    host: text, port: {
        type: "integer", minimum: 1, maximum: 65535
    }, loginRate: { type: "integer", minimum: 1 }, disableWebUI: bool,
    accessControlMode: { enum: [
            "none", "whitelist", "blacklist"
        ] }, ipWhitelist: {
        type: "array", maxItems: 256, items: text
    }, ipBlacklist: {
        type: "array", maxItems: 256, items: text
    }, enableXForwardedFor: bool
});
export type ExtendedWebuiDescriptor = NapcatWebuiManagementDescriptor & {
    readback?: string;
    platform?: "win32" | "linux";
    loggedOutOnly?: boolean;
    query?: boolean;
    endsSession?: boolean;
    stream?: boolean;
    nativeParams?: ApiSchema;
};
const sourceLocations: Record<string, {
    route: number;
    handlers: number[];
}> = {
    "POST /api/NapCatConfig/SetConfig": { "route": 96536, "handlers": [96465] }, "POST /api/NapCatConfig/SetUinConfig": { "route": 96538, "handlers": [96516] }, "POST /api/WebUIConfig/UpdateConfig": { "route": 92202, "handlers": [92076] }, "POST /api/WebUIConfig/UpdateDisableWebUI": { "route": 92204, "handlers": [92034] }, "POST /api/WebUIConfig/DeleteSSLCert": { "route": 92208, "handlers": [92183] }, "POST /api/WebUIConfig/UploadSSLCert": { "route": 92207, "handlers": [92161] }, "POST /api/QQLogin/CreateGUIDBackup": { "route": 71666, "handlers": [71477] }, "POST /api/QQLogin/CreateLinuxMachineInfoBackup": { "route": 71673, "handlers": [71570] }, "POST /api/QQLogin/ResetDeviceID": { "route": 71660, "handlers": [71416] }, "POST /api/QQLogin/ResetLinuxDeviceID": { "route": 71675, "handlers": [71592] }, "POST /api/QQLogin/RestoreGUIDBackup": { "route": 71665, "handlers": [71464] }, "POST /api/QQLogin/RestoreLinuxMachineInfoBackup": { "route": 71674, "handlers": [71579] }, "POST /api/QQLogin/SetDeviceGUID": { "route": 71663, "handlers": [71438] }, "POST /api/QQLogin/SetLinuxMAC": { "route": 71669, "handlers": [71510] }, "POST /api/Plugin/SetStatus": { "route": 96188, "handlers": [95465] }, "POST /api/Plugin/Uninstall": { "route": 96189, "handlers": [95485] }, "POST /api/Plugin/RegisterManager": { "route": 96194, "handlers": [95389] }, "POST /api/Plugin/Config": { "route": 96191, "handlers": [95695] }, "GET /api/base/getAllReleases": { "route": 90533, "handlers": [90385] }, "GET /api/base/getLatestTag": { "route": 90532, "handlers": [90377] }, "GET /api/Plugin/Config": { "route": 96190, "handlers": [95499] }, "POST /api/auth/check": { "route": 89277, "handlers": [89132] }, "POST /api/auth/login": { "route": 89276, "handlers": [89097] }, "POST /api/auth/logout": { "route": 89278, "handlers": [89121] }, "POST /api/Mirror/Test": { "route": 96432, "handlers": [96412] }, "GET /api/Mirror/Test/SSE": { "route": 96431, "handlers": [96341] }, "POST /api/Plugin/Store/Install": { "route": 96198, "handlers": [96012] }, "GET /api/Plugin/Store/Install/SSE": { "route": 96199, "handlers": [96065] }, "POST /api/UpdateNapCat/update": { "route": 92468, "handlers": [92276] }
};
const specs: ExtendedWebuiDescriptor[] = [];
function add(id: string, method: "GET" | "POST", nativePath: string, params: ApiSchema, _line: number, options: Partial<ExtendedWebuiDescriptor> = {}) {
    specs.push({
        id, method, nativePath, params, response: acknowledgement, binding: "management-bootstrap", effects: "configuration-mutation",
        description: "Fixed NapCat4.18.4 native owner. Secret inputs stay in request memory; receipts contain only a request digest. Native acknowledgement is distinct from readback, persistence, restart and external-client atomic CAS.", sourceLines: sourceLocations[method + " " + nativePath]!, ...options
    });
}
add("native-config.set", "POST", "/api/NapCatConfig/SetConfig", config, 96536, { readback: "/api/NapCatConfig/GetConfig" });
add("account-config.set", "POST", "/api/NapCatConfig/SetUinConfig", config, 96538, { readback: "/api/NapCatConfig/GetUinConfig", binding: "login-required" });
add("webui-config.set", "POST", "/api/WebUIConfig/UpdateConfig", webuiConfig, 92202, { readback: "/api/WebUIConfig/GetConfig" });
add("webui-disabled.set", "POST", "/api/WebUIConfig/UpdateDisableWebUI", object({ disable: bool }, ["disable"]), 92204, { readback: "/api/WebUIConfig/GetDisableWebUI" });
add("ssl.delete", "POST", "/api/WebUIConfig/DeleteSSLCert", object({}), 92208);
add("ssl.install", "POST", "/api/WebUIConfig/UploadSSLCert", object({ cert: {
        type: "string", maxLength: 262144, pattern: "-----BEGIN CERTIFICATE-----[\\s\\S]+-----END CERTIFICATE-----"
    }, key: {
        type: "string", maxLength: 262144, pattern: "-----BEGIN[^\\r\\n]*KEY-----"
    } }, ["cert", "key"]), 92207);
for (const [id, native, platform, fields, line] of [
    [
        "device.windows.backup", "CreateGUIDBackup", "win32", {}, 71654
    ], [
        "device.linux.backup", "CreateLinuxMachineInfoBackup", "linux", {}, 71674
    ],
    [
        "device.windows.reset", "ResetDeviceID", "win32", {}, 71652
    ], [
        "device.linux.reset", "ResetLinuxDeviceID", "linux", {}, 71672
    ],
    [
        "device.windows.restore", "RestoreGUIDBackup", "win32", { backupName: { ...text, pattern: "^Registry20\\.bak\\.[A-Za-z0-9._-]+$" } }, 71655
    ],
    [
        "device.linux.restore", "RestoreLinuxMachineInfoBackup", "linux", { backupName: { ...text, pattern: "^machine-info\\.bak\\.[A-Za-z0-9._-]+$" } }, 71675
    ],
    [
        "device.windows.guid.set", "SetDeviceGUID", "win32", { guid: { type: "string", pattern: "^[a-fA-F0-9]{32}$" } }, 71653
    ],
    [
        "device.linux.mac.set", "SetLinuxMAC", "linux", { mac: {
                type: "string", minLength: 1, maxLength: 256
            } }, 71669
    ]
] as const)
    add(id, "POST", "/api/QQLogin/" + native, object(fields, Object.keys(fields)), line, { platform, loggedOutOnly: true });
add("plugin.status.set", "POST", "/api/Plugin/SetStatus", object({ id: pluginId, enable: bool }, ["id", "enable"]), 91563);
add("plugin.uninstall", "POST", "/api/Plugin/Uninstall", object({ id: pluginId, cleanData: bool }, ["id", "cleanData"]), 91564);
add("plugin.manager.register", "POST", "/api/Plugin/RegisterManager", object({}), 91565, { binding: "login-required" });
add("plugin.config.set", "POST", "/api/Plugin/Config", object({ id: pluginId, config: { type: "object", maxProperties: 256 } }, ["id", "config"]), 91567);
const releaseRow = object({
    tag: text, type: { enum: [
            "release", "prerelease", "action"
        ] }, artifactId: { type: "integer" }, artifactName: text, createdAt: text, expiresAt: text, size: { type: "number" }, workflowRunId: { type: "integer" }, headSha: text, workflowTitle: { type: "string", maxLength: 2048 }
}, ["tag", "type"]);
add("releases.list", "GET", "/api/base/getAllReleases", object({
    page: { type: "integer", minimum: 1 }, pageSize: {
        type: "integer", minimum: 1, maximum: 100
    }, type: { enum: [
            "all", "release", "action"
        ] }, search: { type: "string", maxLength: 256 }
}), 90533, {
    query: true, effects: "none", response: object({ versions: { type: "array", items: releaseRow }, pagination: object({
            page: { type: "integer" }, pageSize: { type: "integer" }, total: { type: "integer" }, totalPages: { type: "integer" }
        }, [
            "page", "pageSize", "total", "totalPages"
        ]) }, ["versions", "pagination"])
});
add("releases.latest", "GET", "/api/base/getLatestTag", object({}), 90532, { effects: "none", response: object({ tag: text }, ["tag"]) });
add("plugin.config.summary", "GET", "/api/Plugin/Config", object({ id: pluginId }, ["id"]), 91566, {
    query: true, effects: "none", response: object({
        supportReactive: bool, schemaItems: { type: "integer" }, configKeys: { type: "integer" }, protectedContent: { const: true }, artifact: napcatWebuiObjectReferenceSchema
    }, [
        "supportReactive", "schemaItems", "configKeys", "protectedContent"
    ])
});
add("session.check", "POST", "/api/auth/check", object({}), 90000, { effects: "none", response: object({ authenticated: { const: true } }, ["authenticated"]) });
add("session.login", "POST", "/api/auth/login", object({}), 90000, { description: "Authenticate using only the original configured WebUI credential cache; return no hash/token/Credential. Reuses a still-valid original session without a second login.", endsSession: false });
add("session.logout", "POST", "/api/auth/logout", object({}), 90000, { endsSession: true });
const mirrorResult = object({
    success: bool, latencyMs: { type: "number", minimum: 0 }, mirrorIndex: { type: "integer", minimum: 0 }, nativeError: { type: "boolean" }
}, ["success"]);
add("mirror.test", "POST", "/api/Mirror/Test", object({ type: { enum: ["file", "raw"] }, mirrorIndex: {
        type: "integer", minimum: 0, maximum: 255
    } }, ["type", "mirrorIndex"]), 90000, {
    effects: "none", nativeParams: object({ type: { enum: ["file", "raw"] }, mirror: { type: "string", maxLength: 4096 } }, ["type", "mirror"]), response: mirrorResult
});
add("mirror.tests", "GET", "/api/Mirror/Test/SSE", object({ type: { enum: ["file", "raw"] } }, ["type"]), 90000, {
    effects: "none", stream: true, response: object({
        completed: bool, results: {
            type: "array", maxItems: 256, items: mirrorResult
        }, failed: { type: "integer", minimum: 0 }
    }, [
        "completed", "results", "failed"
    ])
});
add("plugin.store.install", "POST", "/api/Plugin/Store/Install", object({ id: pluginId }, ["id"]), 90000, { readback: "/api/Plugin/List", binding: "login-required" });
add("plugin.store.install.events", "GET", "/api/Plugin/Store/Install/SSE", object({ id: pluginId }, ["id"]), 90000, {
    readback: "/api/Plugin/List", binding: "login-required", stream: true
});
add("native.release.update", "POST", "/api/UpdateNapCat/update", object({
    targetVersion: {
        type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.+-]+$"
    }, force: bool, mirrorIndex: { type: "integer", minimum: 0 }
}, ["targetVersion", "force"]), 90000, {
    nativeParams: object({
        targetVersion: {
            type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.+-]+$"
        }, force: bool, mirror: { type: "string", maxLength: 4096 }
    }, ["targetVersion", "force"]),
    response: object({
        accepted: { const: true }, nativeReadback: { const: false }, newVersion: text, pendingFileCount: { type: "integer", minimum: 0 }, restartRequired: { const: true }, runtimeAdopted: { const: false }
    }, [
        "accepted", "nativeReadback", "newVersion", "pendingFileCount", "restartRequired", "runtimeAdopted"
    ]),
    description: "Fixed original native release updater writes only its own binary/config layout and pending-file journal. Selects official tags/action artifacts and an optional original configured mirror index. This acknowledgement does not restart Host/SDK/QQ or prove current process adoption; pending files require the original native lifecycle and runtimeAdopted remains false."
});
export const napcatWebuiExtendedDescriptors: readonly ExtendedWebuiDescriptor[] = specs;
const validators = new Map(specs.map(spec => [spec, compileApiContract({ contract: { ...contractFor(spec), request: { ...contractFor(spec).request, body: {
                    kind: "json", maxBytes: 1048576, schema: spec.nativeParams ?? spec.params
                } } } }).bodyValidator]));
export function assertNapcatWebuiExtendedRequest(method: string, pathname: string, body: Record<string, unknown>): boolean {
    if ((method === "GET" && pathname === "/api/Plugin/Config/SSE") || (method === "POST" && pathname === "/api/Plugin/Config/Change")) {
        const fields = method === "GET" ? ["id", "config"] : [
            "id", "sessionId", "key", "value", "currentConfig"
        ];
        if (!body || Object.keys(body).some(key => !fields.includes(key)) || typeof body.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body.id))
            throw new Error("NAPCAT_WEBUI_MANAGEMENT_REQUEST_INVALID");
        if (method === "GET" && (body.config !== undefined && typeof body.config !== "string"))
            throw new Error("NAPCAT_WEBUI_MANAGEMENT_REQUEST_INVALID");
        if (method === "POST" && (typeof body.sessionId !== "string" || !body.sessionId || typeof body.key !== "string" || !body.key || !body.currentConfig || typeof body.currentConfig !== "object" || Array.isArray(body.currentConfig)))
            throw new Error("NAPCAT_WEBUI_MANAGEMENT_REQUEST_INVALID");
        return true;
    }
    if (method === "GET" && pathname === "/api/Plugin/List" && body && Object.keys(body).length === 0)
        return true;
    const spec = specs.find(item => item.method === method && item.nativePath === pathname);
    if (!spec)
        return false;
    if (!validators.get(spec)?.(body))
        throw new Error("NAPCAT_WEBUI_MANAGEMENT_REQUEST_INVALID");
    return true;
}

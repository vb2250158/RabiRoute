import path from "node:path";
import { spawn } from "node:child_process";
import { routeRuntimeParts, sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
import type { ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";
import { DesktopSettingsStore, readDesktopSettingsPayload, writeDesktopSettingsPayload } from "./desktopSettings.js";
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "../shared/desktopSettingsContract.js";


export type DesktopConfigFileRoute = {
  id: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
};

export type DesktopConfigFileContext = {
  routeRoot: string;
  rolesRoot: string;
  ensureDataDirs: () => Promise<void>;
  findRoute: (gatewayId: string) => DesktopConfigFileRoute | undefined;
  ensurePersonaConfigFile: (roleId: string) => Promise<string>;
  ensureRoleFile: (roleId: string, roleFile: string) => Promise<string>;
  ensureRoleFolder: (roleId: string, subfolder?: string) => Promise<string>;
  adapterConfigPath: (configName: string) => string;
  writeAdapterConfigFile: (route: DesktopConfigFileRoute) => Promise<void>;
  openPath?: (target: string) => void;
};

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "explorer", target] : [target];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function desktopConfigFilePayload(
  type: string | null,
  gatewayId: string | null,
  roleId: string | null,
  context: DesktopConfigFileContext
): Promise<Record<string, unknown>> {
  const openPath = context.openPath ?? openFileWithDefaultApp;
  if (type === "manager") {
    await context.ensureDataDirs();
    openPath(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const route = gatewayId ? context.findRoute(gatewayId) : undefined;
  if (type === "role" || type === "persona") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由角色，再打开 persona.md。");
    const rolePath = await context.ensureRoleFile(
      safeRoleId,
      route?.agentRoleFile ?? "persona.md"
    );
    openPath(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-folder") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由角色，再打开角色文件夹。");
    const roleDirectory = await context.ensureRoleFolder(safeRoleId);
    openPath(roleDirectory);
    return { code: 0, data: { path: roleDirectory } };
  }

  if (type === "role-message-config") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由角色，再打开 personaConfig.json。");
    const configPath = await context.ensurePersonaConfigFile(safeRoleId);
    openPath(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type === "xiaomi-recordings" || type === "xiaomi-media" || type === "camera-clips") {
    const safeRoleId = sanitizeRoleId(roleId ?? route?.agentRoleId);
    if (!safeRoleId) throw new Error("请先选择一个路由角色，再打开录像文件夹。");
    const mediaDir = await context.ensureRoleFolder(safeRoleId, "xiaomi-media");
    openPath(mediaDir);
    return { code: 0, data: { path: mediaDir } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }
  if (!gatewayId || !route) {
    await context.ensureDataDirs();
    openPath(context.routeRoot);
    return { code: 0, data: { path: context.routeRoot } };
  }

  const configName = sanitizeConfigName(route.configName) || routeRuntimeParts(route.id).configName;
  const configPath = context.adapterConfigPath(configName);
  await context.writeAdapterConfigFile(route);
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openPath(targetPath);
  return { code: 0, data: { path: targetPath } };
}


export type DesktopControlOperationsContext = {
  settings: DesktopSettingsStore;
  readOnly: boolean;
  settingsChanged: (settings: DesktopSettings) => void;
  openConfigFilePayload: (type: string | null, gatewayId: string | null, roleId: string | null) => Promise<Record<string, unknown>>;
};
const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const settingsErrorSchema = { type: "object", required: ["code", "message"], additionalProperties: false, properties: { code: { const: -1 }, message: { type: "string" } } } as const;
const settingsSchema = { type: "object", required: [...Object.keys(DEFAULT_DESKTOP_SETTINGS), "autostartConfigured"], additionalProperties: false, properties: {
  screenshot: { type: "object", required: Object.keys(DEFAULT_DESKTOP_SETTINGS.screenshot), additionalProperties: false, properties: { enabled: { type: "boolean" }, shortcut: { type: "string" }, clipboardShortcut: { type: "string" }, autoCopy: { type: "boolean" } } },
  autostart: { type: "boolean" }, autostartConfigured: { type: "boolean" }, theme: { type: "string" }, webTheme: { type: "string" }, customThemes: { type: "array", items: { type: "object" }, description: "Normalized by the existing shared interface-theme owner." }, pets: { type: "object", description: "Persona bindings normalized by the existing desktop settings owner; no separate pet behavior is implemented here." }
} } as const;
const settingsResponse = { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data: settingsSchema } } } as const;
const readOnlyResult = () => ({ status: 403, body: { code: -1, message: "Manager is read-only." } });

/** One executable definition per existing HTTP operation; owners retain persistence, UI events and file transactions. */
export function createDesktopControlOperations(context: DesktopControlOperationsContext): readonly ApiOperationDefinition[] {
  const definitions: ApiOperationDefinition[] = [{ contract: {
    operationId: "manager.desktop.settings.read", contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/desktop/settings", exposure: "public", transport: "http",
    description: "Read normalized native desktop settings and whether an explicit autostart setting is persisted.",
    request: { path: empty, query: ignored, headers: ignored, body: { kind: "none", allowIgnoredBody: true } }, responses: { "200": settingsResponse },
    effects: { mode: "read", description: "Read the original host settings file through DesktopSettingsStore. Defaults and malformed-file recovery remain owned by the existing normalizer." },
    recovery: { strategy: "repeatable-read", description: "Read the same host settings owner again. This is configuration evidence, not proof that a host UI or startup registration applied it." },
    validators: [{ id: "native-desktop-settings-read", description: "Ignore unknown queries and body bytes. Shared screenshot, theme and pet normalization remain authoritative." }]
  }, handler: () => ({ status: 200, body: readDesktopSettingsPayload(context.settings) }) }];
  for (const method of ["PATCH", "PUT"] as const) {
    const write = (input: ApiOperationInput) => {
      if (context.readOnly) return readOnlyResult();
      try { input.signal?.throwIfAborted(); return { status: 200, body: writeDesktopSettingsPayload(context.settings, input.body, context.settingsChanged) }; }
      catch (error) { return { status: 400, body: { code: -1, message: error instanceof Error ? error.message : String(error) } }; }
    };
    definitions.push({ contract: {
      operationId: "manager.desktop.settings." + method.toLowerCase(), contractVersion: "1.0.0", method, pathTemplate: "/api/desktop/settings", exposure: "public", transport: "http",
      description: "Merge native desktop settings, with a nested screenshot merge. PUT intentionally retains the same merge semantics as PATCH.",
      request: { path: empty, query: ignored, headers: ignored, body: { kind: "json", maxBytes: 0, allowAnyContentType: true, emptyValue: {}, schema: { description: "Native permissive JSON merge, followed by shared settings normalization. Unknown values, arrays, scalars and null preserve the existing owner behavior; no additional validation policy is imposed." } } },
      responses: { "200": settingsResponse, "400": { mediaType: "application/json", schema: settingsErrorSchema }, "403": { mediaType: "application/json", schema: settingsErrorSchema } },
      effects: { mode: "native-settings-write", description: "Read current settings, merge the body and screenshot fields, persist through the original atomic store and mutation audit, then publish desktop_settings_changed with the saved webTheme. The host UI consumes its existing event." },
      recovery: { strategy: "inspect-settings-no-automatic-replay", receiptPath: "/api/desktop/settings", description: "There is no CAS or request idempotency key. Read back the original settings after an uncertain write, including failure after persistence or event publication; do not infer that an error means nothing changed." },
      validators: [{ id: "native-desktop-settings-write", description: "Read-only mode rejects before body consumption. Shared native normalization owns screenshot shortcuts, theme choices and persona pet bindings. Successful writes preserve autostartConfigured=true." }]
    }, prepare: () => context.readOnly ? readOnlyResult() : write, handler: write });
  }
  const openErrorSchema = { type: "object", required: ["code", "errorCode", "message"], additionalProperties: false, properties: { code: { const: -1 }, errorCode: { type: "string" }, message: { type: "string" } } } as const;
  definitions.push({ contract: {
    operationId: "manager.desktop.config.open", contractVersion: "1.0.0", method: "POST", pathTemplate: "/open-config-file", exposure: "public", transport: "http",
    description: "Prepare a native managed config file or folder, then dispatch its existing local desktop opener. This does not prove that a UI window became visible.",
    request: { path: empty, query: { type: "object", additionalProperties: true, properties: Object.fromEntries(["type", "gatewayId", "roleId"].map(key => [key, { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }])) }, headers: ignored, body: { kind: "none", allowIgnoredBody: true } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } } } } }, default: { mediaType: "application/json", schema: openErrorSchema } },
    effects: { mode: "native-prepare-and-open", description: "The original file owner may create or serialize managed configuration before dispatching the platform opener. Types: manager, role/persona, role-folder, role-message-config, xiaomi-recordings/xiaomi-media/camera-clips, routes, route-folder. Role and route sanitization and transaction ownership remain native." },
    recovery: { strategy: "inspect-native-file-no-replay", description: "Retain the selected type and original role/route identity. An error or disconnected response does not prove that file preparation or opener dispatch did not run; inspect original state before repeating. Registration retirement joins preparation through opener dispatch, without closing applications." },
    validators: [{ id: "native-desktop-config-selection", description: "Use the first query value or null, ignore unknown query fields and all body bytes. Preserve native coded 400-599 transaction failures; missing routes fall back to the manager folder for routes/route-folder. This existing public operation does not gain a local-origin or per-feature permission requirement." }]
  }, handler: async input => {
    const first = (key: string) => { const value = input.query[key]; return (Array.isArray(value) ? value[0] : value) ?? null; };
    try { input.signal?.throwIfAborted(); return { status: 200, body: await context.openConfigFilePayload(first("type"), first("gatewayId"), first("roleId")) }; }
    catch (error) {
      const status = Number((error as { statusCode?: unknown } | null)?.statusCode);
      const errorCode = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "request_failed";
      return { status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400, body: { code: -1, errorCode, message: error instanceof Error ? error.message : "Desktop config request failed." } };
    }
  } });
  return definitions;
}

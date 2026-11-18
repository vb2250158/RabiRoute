type Row = Record<string, unknown>;
const configTypes = { fileLog: "boolean", consoleLog: "boolean", fileLogLevel: "string", consoleLogLevel: "string",
  packetBackend: "string", o3HookMode: "number", autoTimeSync: "boolean" } as const;
const bypassKeys = ["hook", "window", "module", "process", "container", "js"] as const;

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QQ_WEBUI_METADATA_RESPONSE_INVALID");
  return value as Row;
}

function configView(value: unknown, scope: string): Row {
  const native = object(value);
  const config: Row = {};
  const invalidFields: string[] = [];
  for (const [field, expectedType] of Object.entries(configTypes)) {
    const fieldValue = native[field];
    if (typeof fieldValue === expectedType && (expectedType !== "number" || Number.isFinite(fieldValue))) config[field] = fieldValue;
    else invalidFields.push(field);
  }
  if (Object.hasOwn(native, "bypass")) {
    if (!native.bypass || typeof native.bypass !== "object" || Array.isArray(native.bypass)) invalidFields.push("bypass");
    else {
      const bypass = native.bypass as Row;
      const view: Row = {};
      for (const key of bypassKeys) {
        if (!Object.hasOwn(bypass, key)) continue;
        if (typeof bypass[key] === "boolean") view[key] = bypass[key];
        else invalidFields.push(`bypass.${key}`);
      }
      config.bypass = view;
    }
  }
  const packetServer = native.packetServer;
  const valueType = packetServer === null ? "null" : Array.isArray(packetServer) ? "array" : typeof packetServer;
  if (typeof packetServer !== "string") invalidFields.push("packetServer");
  return { scope, config, packetServer: { present: Object.hasOwn(native, "packetServer"), valueType,
    ...(typeof packetServer === "string" ? { length: packetServer.length } : {}) }, invalidFields,
    omittedUnknownFieldCount: Object.keys(native).filter(key => !Object.hasOwn(configTypes, key) && !["bypass", "packetServer"].includes(key)).length,
    view: "restricted-native-config-metadata", sourceProvenance: "native-api-does-not-identify-file-or-default-fallback", runtimeApplied: "not-proven" };
}

function mirrorView(value: unknown, index: number): Row | undefined {
  if (typeof value !== "string") return;
  if (value === "") return { index, direct: true, pathPresent: false, pathLength: 0, limitedDisplay: true, executable: false };
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol)) return;
  return { index, direct: false, origin: url.origin, pathPresent: url.pathname !== "/" && url.pathname !== "", pathLength: url.pathname.length,
    hasUserinfo: Boolean(url.username || url.password), hasQuery: Boolean(url.search), hasFragment: Boolean(url.hash), limitedDisplay: true, executable: false };
}

function mirrorList(value: unknown): Row {
  const native = object(value);
  if (!Array.isArray(native.fileMirrors) || !Array.isArray(native.rawMirrors)) throw new Error("QQ_WEBUI_METADATA_RESPONSE_INVALID");
  let invalidItems = 0;
  const projectRows = (values: unknown[]) => values.flatMap((entry, index) => {
    const projected = mirrorView(entry, index);
    if (!projected) { invalidItems++; return []; }
    return [projected];
  });
  const fileMirrors = projectRows(native.fileMirrors);
  const rawMirrors = projectRows(native.rawMirrors);
  let customMirror: Row | null = null;
  if (native.customMirror !== "" && native.customMirror !== undefined && native.customMirror !== null) {
    customMirror = mirrorView(native.customMirror, 0) ?? null;
    if (!customMirror) invalidItems++;
  }
  const timeoutValid = typeof native.timeout === "number" && Number.isFinite(native.timeout) && native.timeout >= 0;
  return { fileMirrors, rawMirrors, customMirror, invalidItems,
    ...(timeoutValid ? { timeoutMs: native.timeout } : {}), timeoutValid, view: "limited-native-mirror-display", executable: false };
}

export function projectNapcatWebuiMetadata(id: string, value: unknown): Row | undefined {
  if (id === "napcat-global-config") return configView(value, "global");
  if (id === "napcat-account-config") return configView(value, "native-current-qq");
  if (id === "webui-font-exists") {
    if (typeof value !== "boolean") throw new Error("QQ_WEBUI_METADATA_RESPONSE_INVALID");
    return { exists: value };
  }
  if (id === "mirror-list") return mirrorList(value);
}

import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import type { createRabiApiOwner } from "./rabiApi.js";

const targetDirectoryId = "manager.device-control.targets.list";
const executeId = "manager.device-control.execute";
const category = { id: "devices", title: "电脑与设备" };
const identity = { type: "string", minLength: 1, maxLength: 256 };
const computerTarget = {
  type: "object", additionalProperties: false, required: ["kind", "instanceId"],
  properties: { kind: { const: "computer" }, instanceId: identity, ownerDeviceId: identity }
};
const phoneTarget = {
  type: "object", additionalProperties: false, required: ["kind", "deviceId", "guid"],
  properties: { kind: { const: "phone" }, deviceId: identity, guid: { type: "string", maxLength: 256 } }
};
const displayTarget = (active: boolean): ApiSchema => ({
  type: "object", additionalProperties: false, required: active ? ["kind", "bridgeId", "surfaceId"] : ["kind", "bridgeId"],
  properties: { kind: { const: "android-display" }, bridgeId: identity, ownerDeviceId: identity, ...(active ? { surfaceId: identity } : {}) }
});
const phoneFrameSource = { type: "object", required: ["instanceId", "frameId", "layoutRevision"],
  properties: { instanceId: identity, frameId: identity, layoutRevision: identity }, additionalProperties: true };
const phoneRequestId = { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_.:-]+$" };
const point = { type: "number", minimum: 0, maximum: 7680 };
const touchAction = (name: string, properties: Record<string, ApiSchema>): ApiSchema => ({
  type: "object", additionalProperties: false, required: ["type", ...Object.keys(properties)],
  properties: { type: { const: name }, ...properties }
});
const phoneTouchActions = [
  touchAction("click", { x: point, y: point }),
  touchAction("longPress", { x: point, y: point, durationMs: { type: "integer", minimum: 500, maximum: 1200 } }),
  touchAction("swipe", { x: point, y: point, endX: point, endY: point, durationMs: { type: "integer", minimum: 100, maximum: 1200 } }),
  touchAction("back", {})
];
const phoneChangeWait = { type: "object", additionalProperties: false, required: ["waitMs"],
  properties: { waitMs: { type: "integer", minimum: 100, maximum: 5000 } } };
const phoneAppProperties = { target: phoneTarget, action: { const: "apps.open" },
  requestId: phoneRequestId, appId: { type: "string", minLength: 3, maxLength: 350 }, source: phoneFrameSource };
const phoneScreenBranches: (Readonly<Record<string, unknown>> & { properties: Record<string, ApiSchema> })[] = [
  { type: "object", additionalProperties: false, required: ["target", "action"],
    properties: { target: phoneTarget, action: { const: "screen.status" } } },
  { type: "object", additionalProperties: false, required: ["target", "action"],
    properties: { target: phoneTarget, action: { const: "screen.capture" }, maxWidth: { type: "integer", minimum: 16, maximum: 1920 } } },
  { type: "object", additionalProperties: false, required: ["target", "action", "source"], properties: {
    target: phoneTarget, action: { const: "screen.wait" }, waitMs: { type: "integer", minimum: 100, maximum: 5000 },
    source: phoneFrameSource
  } },
  { type: "object", additionalProperties: false, required: ["target", "action", "requestId", "source", "actions"], properties: {
    target: phoneTarget, action: { const: "input.perform" }, requestId: phoneRequestId, source: phoneFrameSource,
    actions: { type: "array", minItems: 1, maxItems: 32, items: { anyOf: phoneTouchActions } },
    captureAfter: { description: "After completed input, return the current image, or wait for change from the supplied source. Original receipts retain the capture outcome without image bytes.", anyOf: [
      { type: "boolean" }, phoneChangeWait
    ] }
  } },
  { type: "object", additionalProperties: false, required: ["target", "action", "requestId"],
    properties: { target: phoneTarget, action: { enum: ["input.status", "input.cancel"] }, requestId: phoneRequestId } },
  { type: "object", additionalProperties: false, required: ["target", "action"],
    properties: { target: phoneTarget, action: { const: "apps.list" } } },
  { type: "object", additionalProperties: false, required: ["target", "action", "requestId", "appId"],
    properties: { ...phoneAppProperties, captureAfter: { type: "boolean" } } },
  { type: "object", additionalProperties: false, required: ["target", "action", "requestId", "appId", "source", "captureAfter"],
    properties: { ...phoneAppProperties, captureAfter: phoneChangeWait } }
];
const empty = { type: "object", additionalProperties: false };
const androidDisplayBranches: ApiSchema[] = [
  { type: "object", additionalProperties: false, required: ["target", "action", "requestId"],
    properties: { target: displayTarget(false), action: { const: "display.open" }, requestId: phoneRequestId } },
  { type: "object", additionalProperties: false, required: ["target", "action"],
    properties: { target: displayTarget(true), action: { enum: ["display.close", "screen.status", "screen.capture", "apps.list"] } } },
  ...phoneScreenBranches.filter(branch => {
    const values = (branch.properties?.action as { const?: string; enum?: string[] } | undefined);
    return values?.enum?.includes("input.status") || ["screen.wait", "input.perform", "apps.open"].includes(values?.const ?? "");
  }).map(branch => ({
    ...branch,
    properties: { ...branch.properties, target: displayTarget(true),
      ...(branch.properties.actions && typeof branch.properties.actions === "object"
        ? { actions: { ...branch.properties.actions, items: { anyOf: phoneTouchActions.slice(0, 3) } } } : {})
    }
  }))
];
const headers = { "cache-control": "no-store" };
const json = { mediaType: "application/json", schema: { type: "object" } };
const directoryResponse = {
  type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: {
    type: "object", required: ["targets", "sourceErrors"], properties: {
      targets: { type: "array", items: {
        type: "object", required: ["name", "online", "capabilities", "target"], properties: {
          name: { type: "string" }, online: { type: "boolean" }, capabilities: { type: "array", items: { type: "string" } },
          target: { anyOf: [computerTarget, phoneTarget, displayTarget(false), displayTarget(true)] }
        }
      } },
      sourceErrors: { type: "array", items: { type: "object" } }
    }
  } }
};
const success = (data: unknown): ApiOperationResult => ({ status: 200, headers, body: { code: 0, data } });
const unavailable = (status: number, errorCode: string, message: string): ApiOperationResult => ({
  status, headers, body: { code: -1, errorCode, message }
});

type ComputerTarget = { kind: "computer"; instanceId: string; ownerDeviceId?: string };
type PhoneTarget = { kind: "phone"; deviceId: string; guid: string };
export type AndroidDisplayTarget = { kind: "android-display"; bridgeId: string; surfaceId?: string; ownerDeviceId?: string };
type DeviceTarget = ComputerTarget | PhoneTarget | AndroidDisplayTarget;
type ActionBranch = { required: string[]; properties: Record<string, ApiSchema>; [key: string]: unknown };

export type DeviceComputerPort = Readonly<{
  operation: ApiOperationDefinition;
  list(): Promise<{ computers: Record<string, unknown>[]; sourceErrors: readonly unknown[] }>;
  invoke(input: ApiOperationInput, target: ComputerTarget): Promise<ApiOperationResult>;
  observationLabel?(request: ApiOperationInput["request"]): Promise<string | undefined>;
  androidDisplays?: {
    list(signal?: AbortSignal, ownedOnly?: boolean): Promise<{ targets: Record<string, unknown>[]; sourceErrors: readonly unknown[] }>;
    execute(target: AndroidDisplayTarget, body: Record<string, unknown>, label: string | undefined, signal?: AbortSignal,
      request?: ApiOperationInput["request"]): Promise<ApiOperationResult>;
  };
}>;

function targetBranches(operation: ApiOperationDefinition, target: ApiSchema, omittedField?: string): ActionBranch[] {
  const body = operation.contract.request.body;
  if (body.kind !== "json") throw new TypeError("Device control requires a JSON action contract.");
  const schema = body.schema as { anyOf: ActionBranch[] };
  return schema.anyOf.map(branch => {
    const properties = { ...branch.properties };
    if (omittedField) delete properties[omittedField];
    return { ...branch, required: [...branch.required.filter(field => field !== omittedField), "target"],
      properties: { ...properties, target } };
  });
}

export function createDeviceControlOperations(computer: DeviceComputerPort, owner: ReturnType<typeof createRabiApiOwner>,
  phoneLocation: ApiOperationDefinition): readonly ApiOperationDefinition[] {
  const desktop = computer.operation.contract;
  const displayGamepadBranches = computer.androidDisplays ? targetBranches(computer.operation, displayTarget(true))
    .filter(branch => {
      const action = branch.properties.action as { const?: string } | undefined;
      return ["input.gamepad", "input.gamepad.status", "input.gamepad.close"].includes(action?.const ?? "");
    }) : [];
  const requests = {
    description: "Select a target from manager.device-control.targets.list and use the action supported by that device, retaining the same request ID for input status.",
    anyOf: [...targetBranches(computer.operation, computerTarget), ...targetBranches(phoneLocation, phoneTarget, "targetGuid"), ...phoneScreenBranches,
      ...(computer.androidDisplays ? [...androidDisplayBranches, ...displayGamepadBranches] : [])]
  };
  const response = desktop.responses["200"]!;
  const desktopResult = response.schema as { properties: Record<string, ApiSchema> };
  const locationSettingsResult = { type: "object", required: ["enabled", "permission"],
    properties: { enabled: { type: "boolean" }, permission: { enum: ["none", "approximate", "precise"] } } };
  const screenStatusResult = { type: "object", required: ["state"], properties: {
    state: { enum: ["sharing", "consent-required"] },
    layoutRevision: identity,
    activity: { type: "object", required: ["observations"], properties: {
      observations: { type: "array", items: { type: "object", required: ["id", "label"],
        properties: { id: identity, label: identity } } },
      operation: { type: "object", required: ["requestId", "label"], properties: { requestId: phoneRequestId, label: identity } },
      pointer: { type: "object", description: "A current touch or swipe on this layout. Coordinates are fractions of the native phone screen.",
        required: ["requestId", "label", "kind", "x", "y", "startX", "startY", "remainingMs"],
        properties: {
          requestId: phoneRequestId, label: identity, kind: { enum: ["click", "longPress", "swipe"] },
          remainingMs: { type: "integer", minimum: 1, maximum: 1650 },
          ...Object.fromEntries(["x", "y", "startX", "startY"].map(key => [key, { type: "number", minimum: 0, maximum: 1 }]))
        } }
    } }
  } };
  const result = { ...desktopResult, properties: { ...desktopResult.properties,
    data: { anyOf: [desktopResult.properties.data!, locationSettingsResult, screenStatusResult] } } };
  const selected = "/api/device-control/targets";
  return [{
    contract: {
      operationId: targetDirectoryId, contractVersion: "1.0.0", exposure: "public", transport: "http",
      method: "GET", pathTemplate: selected, description: "List control targets from the existing computer and RabiLink phone owners.",
      request: { path: empty, query: { type: "object", additionalProperties: false,
        properties: { kind: { enum: ["android-display"] }, location: { enum: ["local"] } } }, headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { ...json, schema: directoryResponse }, default: json },
      effects: { mode: "read", description: "Read current device identities, capabilities, and connection state." },
      recovery: { strategy: "repeatable-read", description: "Refresh the directory when a target changes or a source becomes unavailable." },
      validators: []
    },
    discovery: { title: "列出设备控制目标", summary: "返回本机电脑、远端电脑、手机和 Android 独立屏的原始 target 及能力。远端目标保留 ownerDeviceId，供统一设备控制直接使用。",
      category, keywords: ["设备控制", "控制设备", "手机控制", "远端节点", "device control"], relatedOperations: [executeId] },
    async handler(input) {
      if (!hasAuthenticatedConnectionRequest(input.request)) return unavailable(401, "DEVICE_CONTROL_AUTH_REQUIRED", "Use an authenticated Rabi connection.");
      const ownedOnly = input.query.location === "local";
      if (ownedOnly && input.query.kind !== "android-display") return unavailable(400, "DEVICE_CONTROL_TARGET_FILTER_INVALID", "Use location=local with kind=android-display.");
      if (input.query.kind === "android-display") {
        const displays = await computer.androidDisplays?.list(input.signal, ownedOnly);
        input.signal?.throwIfAborted();
        hasAuthenticatedConnectionRequest(input.request);
        return success(displays ?? { targets: [], sourceErrors: [] });
      }
      const [computers, phones, displays] = await Promise.allSettled([
        computer.list(), owner.homeDevices(input.signal, true), computer.androidDisplays?.list(input.signal)
      ]);
      input.signal?.throwIfAborted();
      hasAuthenticatedConnectionRequest(input.request);
      const targets: Record<string, unknown>[] = [];
      const sourceErrors: unknown[] = [];
      if (computers.status === "fulfilled") {
        sourceErrors.push(...computers.value.sourceErrors);
        for (const row of computers.value.computers) {
          if (typeof row.instanceId !== "string" || !row.instanceId) continue;
          targets.push({ name: row.name || row.hostname || row.instanceId, online: row.status === "online", capabilities: row.capabilities ?? [],
            target: { kind: "computer", instanceId: row.instanceId, ...(row.ownerDeviceId ? { ownerDeviceId: row.ownerDeviceId } : {}) } });
        }
      } else sourceErrors.push({ source: "computers", message: "Unable to read the computer directory." });
      if (phones.status === "fulfilled") {
        for (const row of phones.value.devices) if (row.deviceKind === "phone") {
          targets.push({ name: row.labels?.alias || row.name, online: row.online, capabilities: row.capabilities,
            target: { kind: "phone", deviceId: row.id, guid: row.guid } });
        }
      } else sourceErrors.push({ source: "phones", message: "Unable to read the phone directory." });
      if (displays.status === "fulfilled" && displays.value) {
        targets.push(...displays.value.targets);
        sourceErrors.push(...displays.value.sourceErrors);
      } else if (displays.status === "rejected") sourceErrors.push({ source: "android-display", message: "Unable to read Android display bridges." });
      return success({ targets, sourceErrors });
    }
  }, {
    contract: {
      ...desktop, operationId: executeId, pathTemplate: "/api/device-control/execute",
      description: "Use the selected device's original executor for screen capture, input, and phone location.",
      request: { ...desktop.request, path: empty, body: { ...desktop.request.body as Extract<typeof desktop.request.body, { kind: "json" }>, schema: requests } },
      responses: { "200": { ...response, schema: result }, default: json },
      effects: { ...desktop.effects, request: { bodyPath: ["action"], modes: {
        ...desktop.effects.request?.modes, "screen.status": "read", "apps.list": "read", "apps.open": "write",
        "location.read": "read", "location.settings.read": "read", "location.settings.update": "write",
        ...(computer.androidDisplays ? { "display.open": "write", "display.close": "write" } : {})
      } } },
    },
    discovery: { title: "设备控制", summary: "从设备目录选择 target 后用同一入口查看屏幕、执行输入、打开应用或读取手机定位。Android 独立屏通过 display.open 返回原目标，用该目标操作并以 display.close 关闭。目标公布 input.gamepad 时可传同一手柄帧合同。保留 appId 和原 requestId，可用 input.status 查询触屏、启动或独立屏手柄回执。",
      category, keywords: ["设备控制", "操作设备", "手机控制", "电脑控制", "触屏", "点按", "滑动", "应用目录", "打开手机应用", "跨机", "手柄", "虚拟屏", "gamepad", "phone location", "device control"],
      inputSources: [{ field: "body.target", operationId: targetDirectoryId, resultPath: "/data/targets", valuePath: "/target" }],
      relatedOperations: [targetDirectoryId, desktop.operationId, phoneLocation.contract.operationId] },
    async handler(input) {
      if (!hasAuthenticatedConnectionRequest(input.request)) return unavailable(401, "DEVICE_CONTROL_AUTH_REQUIRED", "Use an authenticated Rabi connection.");
      const { target, ...body } = input.body as Record<string, unknown> & { target: DeviceTarget };
      if (target.kind === "computer") return computer.invoke({ ...input, body }, target);
      const lifecycle = owner.assertLifecycle(input.request);
      if (lifecycle) return lifecycle;
      if (target.kind === "android-display") {
        if (!computer.androidDisplays) return unavailable(503, "ANDROID_DISPLAY_UNAVAILABLE", "The Android display owner is unavailable.");
        const label = ["input.perform", "input.gamepad", "apps.open", "screen.capture", "screen.wait"].includes(String(body.action))
          ? await computer.observationLabel?.(input.request) : undefined;
        input.signal?.throwIfAborted();
        hasAuthenticatedConnectionRequest(input.request);
        const result = await computer.androidDisplays.execute(target, body, label, input.signal, input.request);
        hasAuthenticatedConnectionRequest(input.request);
        return result;
      }
      const forwarded = { ...body, targetGuid: target.guid };
      let result: ApiOperationResult;
      if (["screen.", "input.", "apps."].some(prefix => String(body.action).startsWith(prefix))) {
        const showsNotice = ["screen.capture", "screen.wait", "input.perform", "apps.open"].includes(String(body.action));
        const observerLabel = showsNotice ? await computer.observationLabel?.(input.request) : undefined;
        input.signal?.throwIfAborted();
        hasAuthenticatedConnectionRequest(input.request);
        result = await owner.phoneScreen(target.deviceId, { ...forwarded, ...(observerLabel ? { observerLabel } : {}) }, input.signal);
      } else {
        result = await owner.phoneLocation(target.deviceId, forwarded, input.signal);
      }
      input.signal?.throwIfAborted();
      hasAuthenticatedConnectionRequest(input.request);
      return result;
    }
  }];
}

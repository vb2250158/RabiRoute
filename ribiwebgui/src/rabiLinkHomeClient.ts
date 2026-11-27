export interface RabiLinkHomeDevice {
  id: string;
  guid: string;
  name: string;
  online: boolean;
  capabilities: string[];
  kind?: string;
  deviceKind?: string;
  deviceModel?: string;
  clientKind?: string;
  platform?: string;
  rabiPcVersion?: string | null;
  isLocal?: boolean;
  labels?: { alias: string; tags: string[] };
  labelRevision?: string;
}
export interface RabiLinkHomeData {
  devices: RabiLinkHomeDevice[];
  checkedAt: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Only the local Manager reads the stored application credential. */
export async function readRabiLinkHome(signal: AbortSignal, request: typeof fetch = fetch): Promise<RabiLinkHomeData> {
  const response = await request("/api/rabi/link-home", { method: "GET", cache: "no-store", signal });
  if (!response.ok) throw new Error("暂时无法读取已连接设备，请检查服务器连接后重试。");
  const payload: unknown = await response.json();
  if (!record(payload) || payload.code !== 0 || !record(payload.data)) throw new Error("服务器返回的数据不完整，请刷新重试。");
  const { devices, checkedAt } = payload.data;
  if (!Array.isArray(devices) || typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt))) throw new Error("服务器返回的数据不完整，请刷新重试。");
  const result = devices.map((device): RabiLinkHomeDevice => {
    if (!record(device) || typeof device.id !== "string" || typeof device.guid !== "string" || typeof device.name !== "string" || typeof device.online !== "boolean" || !Array.isArray(device.capabilities) || !device.capabilities.every(value => typeof value === "string")) {
      throw new Error("服务器返回的数据不完整，请刷新重试。");
    }
    if ((device.rabiPcVersion !== undefined && device.rabiPcVersion !== null && (typeof device.rabiPcVersion !== "string" || !device.rabiPcVersion.trim()))
      || (device.isLocal !== undefined && typeof device.isLocal !== "boolean")) {
      throw new Error("服务器返回的数据不完整，请刷新重试。");
    }
    const kind = typeof device.kind === "string" ? device.kind : (typeof device.deviceKind === "string" ? device.deviceKind : undefined);
    const deviceModel = typeof device.deviceModel === "string" ? device.deviceModel : (typeof device.model === "string" ? device.model : undefined);
    const clientKind = typeof device.clientKind === "string" ? device.clientKind : undefined;
    const platform = typeof device.platform === "string" ? device.platform : undefined;
    const labels = record(device.labels) && typeof device.labels.alias === "string" && Array.isArray(device.labels.tags)
      && device.labels.tags.every(tag => typeof tag === "string")
      ? { labels: { alias: device.labels.alias, tags: [...device.labels.tags] } } : {};
    return {
      id: device.id,
      guid: device.guid,
      name: device.name,
      online: device.online,
      capabilities: [...device.capabilities],
      ...(kind ? { kind } : {}),
      ...(typeof device.deviceKind === "string" ? { deviceKind: device.deviceKind } : {}),
      ...(deviceModel ? { deviceModel } : {}),
      ...(clientKind ? { clientKind } : {}),
      ...(platform ? { platform } : {}),
      ...(device.rabiPcVersion !== undefined ? { rabiPcVersion: device.rabiPcVersion as string | null } : {}),
      ...(device.isLocal !== undefined ? { isLocal: device.isLocal as boolean } : {}),
      ...(typeof device.labelRevision === "string" ? { labelRevision: device.labelRevision } : {}),
      ...labels
    };
  });
  return { devices: result, checkedAt };
}

export async function saveRabiLinkDeviceLabels(device: RabiLinkHomeDevice, labels: NonNullable<RabiLinkHomeDevice["labels"]>, request: typeof fetch = fetch): Promise<void> {
  if (!device.labelRevision) throw new Error("请刷新设备列表后重试。");
  const response = await request(`/api/rabi/link-home/devices/${encodeURIComponent(device.id)}/labels`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...labels, guid: device.guid, expectedRevision: device.labelRevision
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(response.status === 409 ? "设备信息已更新，请刷新后重试。" : "无法保存别名和标签，请稍后重试。");
  }
}

async function requestPhoneOperation(channel: "files" | "location", device: Pick<RabiLinkHomeDevice, "id" | "guid">,
  input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/rabi/link-home/devices/${encodeURIComponent(device.id)}/${channel}`, {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, targetGuid: device.guid })
  });
  return readPhoneOperationResult(response, `PHONE_${channel.toUpperCase()}_TRANSPORT_UNCONFIRMED`);
}

async function readPhoneOperationResult(response: Response, transportError: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0 || !record(payload?.data)) {
    throw new Error(typeof payload?.errorCode === "string" ? payload.errorCode
      : transportError);
  }
  return payload.data;
}

export function requestPhoneFileOperation(device: Pick<RabiLinkHomeDevice, "id" | "guid">,
  input: Record<string, unknown>, signal: AbortSignal) {
  return requestPhoneOperation("files", device, input, signal);
}

export function requestPhoneLocationOperation(device: Pick<RabiLinkHomeDevice, "id" | "guid">,
  input: Record<string, unknown>, signal: AbortSignal) {
  return requestPhoneOperation("location", device, input, signal);
}

export type PhoneControlAction = { action: "screen.status" | "screen.capture" | "apps.list" }
  | { action: "screen.wait"; source: Record<string, unknown>; waitMs?: number }
  | { action: "input.perform"; requestId: string; source: Record<string, unknown>; captureAfter?: boolean | { waitMs: number }; actions: Array<{ type: "click"; x: number; y: number } | { type: "back" }> }
  | { action: "apps.open"; requestId: string; appId: string; source?: Record<string, unknown>; captureAfter?: boolean | { waitMs: number } }
  | { action: "input.status" | "input.cancel"; requestId: string };

export type AndroidDisplayTarget = { kind: "android-display"; bridgeId: string; surfaceId?: string; ownerDeviceId?: string };
type DeviceScreenTarget = { kind: "phone"; deviceId: string; guid: string } | AndroidDisplayTarget;
export type AndroidDisplayDirectoryEntry = { target: AndroidDisplayTarget; name: string; online: boolean };

export async function readAndroidDisplayDirectory(signal: AbortSignal, accessToken?: string): Promise<AndroidDisplayDirectoryEntry[]> {
  const response = await fetch("/api/device-control/targets?kind=android-display", {
    signal, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}
  });
  if (response.status === 404) return [];
  const payload = await readPhoneOperationResult(response, "ANDROID_DISPLAY_DIRECTORY_UNAVAILABLE");
  return Array.isArray(payload.targets) ? payload.targets.filter((entry): entry is AndroidDisplayDirectoryEntry =>
    entry?.target?.kind === "android-display" && typeof entry.target.bridgeId === "string" &&
    (entry.target.surfaceId === undefined || typeof entry.target.surfaceId === "string") &&
    (entry.target.ownerDeviceId === undefined || typeof entry.target.ownerDeviceId === "string") &&
    typeof entry.name === "string" && typeof entry.online === "boolean") : [];
}

export function requestPhoneScreenOperation(device: Pick<RabiLinkHomeDevice, "id" | "guid">, input: PhoneControlAction,
  signal: AbortSignal, accessToken?: string) {
  return requestDeviceScreenOperation({ kind: "phone", deviceId: device.id, guid: device.guid }, input, signal, accessToken);
}

export async function requestDeviceScreenOperation(target: DeviceScreenTarget,
  input: PhoneControlAction | { action: "display.open"; requestId: string } | { action: "display.close" },
  signal: AbortSignal, accessToken?: string) {
  const response = await fetch("/api/device-control/execute", {
    method: "POST", signal, headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ ...input, target })
  });
  return readPhoneOperationResult(response, "PHONE_SCREEN_TRANSPORT_UNCONFIRMED");
}

export function rabiLinkDeviceKind(device: RabiLinkHomeDevice): "phone" | "glasses" | "desktop" {
  const kind = device.deviceKind || device.kind;
  if (kind === "phone" || kind === "glasses") return kind;
  if (kind === "pc") return "desktop";
  const text = `${device.kind || ""} ${device.deviceKind || ""} ${device.clientKind || ""} ${device.platform || ""} ${device.deviceModel || ""} ${device.name || ""} ${device.id || ""}`.toLowerCase();
  if (text.includes("glass") || text.includes("rokid") || text.includes("ar")) return "glasses";
  if (text.includes("phone") || text.includes("mobile") || text.includes("android") || text.includes("ios") || text.includes("iphone") || text.includes("xiaomi") || text.includes("huawei") || text.includes("23116pn5bc")) return "phone";
  return "desktop";
}

export function rabiPcVersionLabel(version: string | null | undefined, translate: (text: string) => string = text => text): string {
  return version ? `RabiPC v${version}` : `RabiPC ${translate("版本未知")}`;
}

export function rabiLinkDeviceVersionLabel(device: RabiLinkHomeDevice, translate?: (text: string) => string): string {
  return (device.deviceKind || device.kind) === "pc" ? rabiPcVersionLabel(device.rabiPcVersion, translate) : "";
}

export function rabiLinkDeviceIcon(device: RabiLinkHomeDevice): string {
  const kind = rabiLinkDeviceKind(device);
  if (kind === "glasses") return "mdi-glasses";
  if (kind === "phone") return "mdi-cellphone";
  return "mdi-monitor";
}

export function rabiLinkDeviceDisplayName(device: RabiLinkHomeDevice): string {
  const kind = rabiLinkDeviceKind(device);
  const fallback = kind === "glasses" ? "Rokid 眼镜" : (kind === "phone" ? "移动设备" : "未命名设备");
  if (device.deviceModel && device.name && device.deviceModel !== device.name) {
    return `${device.name} (${device.deviceModel})`;
  }
  return device.deviceModel || device.name || fallback;
}

const capabilityLabels: Record<string, string> = {
  agent: "智能体",
  "mobile-agent": "移动智能体",
  "phone-files-v1": "文件操作",
  "phone-screen-v1": "手机屏幕共享",
  "phone-input-v1": "手机触屏",
  "phone-apps-v1": "打开手机应用",
  "glasses-agent": "眼镜智能体",
  tasks: "任务处理", webgui: "网页管理",
  speech: "语音服务", tts: "语音合成", asr: "语音识别",
  "peer-rpc": "跨电脑调用", "peer-tunnel": "跨电脑连接"
};

export function rabiLinkCapabilities(capabilities: string[], deviceKind?: "phone" | "glasses" | "desktop") {
  const effective = new Set(capabilities);
  if ((deviceKind === "phone" || deviceKind === "glasses") && effective.size === 0) {
    effective.add("agent");
  }
  const known: string[] = [];
  const advanced: string[] = [];
  for (const value of effective) {
    if (value === "phone-file-control-v1") continue;
    const label = Object.hasOwn(capabilityLabels, value) ? capabilityLabels[value] : undefined;
    if (label) known.push(label); else advanced.push(value);
  }
  return { known, advanced };
}

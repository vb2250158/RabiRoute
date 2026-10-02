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
  if (!response.ok) throw new Error("暂时无法读取已授权设备，请检查服务器连接后重试。");
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
      ...(device.isLocal !== undefined ? { isLocal: device.isLocal as boolean } : {})
    };
  });
  return { devices: result, checkedAt };
}

export function rabiLinkDeviceKind(device: RabiLinkHomeDevice): "phone" | "glasses" | "desktop" {
  if ((device.deviceKind || device.kind) === "pc") return "desktop";
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
    const label = Object.hasOwn(capabilityLabels, value) ? capabilityLabels[value] : undefined;
    if (label) known.push(label); else advanced.push(value);
  }
  return { known, advanced };
}

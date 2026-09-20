export interface RabiLinkHomeDevice {
  id: string;
  guid: string;
  name: string;
  online: boolean;
  capabilities: string[];
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
  if (!response.ok) throw new Error("暂时无法读取已授权电脑，请检查服务器连接后重试。");
  const payload: unknown = await response.json();
  if (!record(payload) || payload.code !== 0 || !record(payload.data)) throw new Error("服务器返回的数据不完整，请刷新重试。");
  const { devices, checkedAt } = payload.data;
  if (!Array.isArray(devices) || typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt))) throw new Error("服务器返回的数据不完整，请刷新重试。");
  const result = devices.map((device): RabiLinkHomeDevice => {
    if (!record(device) || typeof device.id !== "string" || typeof device.guid !== "string" || typeof device.name !== "string" || typeof device.online !== "boolean" || !Array.isArray(device.capabilities) || !device.capabilities.every(value => typeof value === "string")) {
      throw new Error("服务器返回的数据不完整，请刷新重试。");
    }
    return { id: device.id, guid: device.guid, name: device.name, online: device.online, capabilities: [...device.capabilities] };
  });
  return { devices: result, checkedAt };
}

const capabilityLabels: Record<string, string> = {
  tasks: "任务处理", webgui: "网页管理",
  speech: "语音服务", tts: "语音合成", asr: "语音识别",
  "peer-rpc": "跨电脑调用", "peer-tunnel": "跨电脑连接"
};
export function rabiLinkCapabilities(capabilities: string[]) {
  const known: string[] = [];
  const advanced: string[] = [];
  for (const value of new Set(capabilities)) {
    const label = Object.hasOwn(capabilityLabels, value) ? capabilityLabels[value] : undefined;
    if (label) known.push(label); else advanced.push(value);
  }
  return { known, advanced };
}

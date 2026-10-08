import type { HomeDeviceDirectory } from "@shared/homeDeviceDirectoryContract";
import type { HomeEntityAction } from "../../src/integrations/xiaomiHome/entityActions";
import type { XiaomiHomeResource } from "./xiaomiHomeSettingsClient";

export type DeviceResource = XiaomiHomeResource & { actions?: HomeEntityAction[] };
export type DeviceDirectory = HomeDeviceDirectory<DeviceResource>;
export type DeviceActionChoice = { id: string; title: string; capability: string; action?: HomeEntityAction; argumentsSchema: Record<string, unknown> };
export type ActionResult = { idempotencyKey: string; state: string; receipt?: Record<string, unknown>; error?: string };
const root = "/api/agent/xiaomi-home";
class RequestFailure extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
 const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000), ...init });
 const body = await response.json();
 if (!response.ok || body.code !== 0) throw new RequestFailure(response.status, body.error?.message || body.message || `请求失败（${response.status}）`);
 return body.data;
}
async function identity() {
 const response = await fetch("/meta", { cache: "no-store", signal: AbortSignal.timeout(12000) });
 const meta = await response.json();
 if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw Error("运行版本不可确认，请刷新页面。");
 return { applicationGenerationId: String(meta.applicationGenerationId), managerInstanceId: String(meta.managerInstanceId) };
}
function sameIdentity(a: Awaited<ReturnType<typeof identity>>, b: Awaited<ReturnType<typeof identity>>) {
 return a.applicationGenerationId === b.applicationGenerationId && a.managerInstanceId === b.managerInstanceId;
}
async function inspect(resourceId: string, signal?: AbortSignal): Promise<DeviceResource> { return request(root + "/entity-actions?" + new URLSearchParams({ resourceId }), signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) } : {}); }
async function receipt(key: string): Promise<ActionResult> { return request(root + "/action-requests?" + new URLSearchParams({ idempotencyKey: key })); }
async function execute(resourceId: string, choice: DeviceActionChoice, parameters: Record<string, unknown>, dryRun: boolean, key: string): Promise<ActionResult> {
 const before = await identity();
 const fresh = await inspect(resourceId);
 if (choice.action) {
  const action = fresh.actions?.find(item => item.action === choice.action!.action);
  if (!action || action.revision !== choice.action.revision) throw Error("动作或参数已变化，请重新选择后执行。");
 } else if (!fresh.capabilities.includes(choice.capability)) throw Error("设备当前不支持此动作，请刷新能力列表。");
 if (!sameIdentity(before, await identity())) throw Error("运行版本已变化，请刷新能力列表。");
 const body = { resourceId, capability: choice.capability,
  arguments: choice.action ? { action: choice.action.action, actionRevision: choice.action.revision, parameters } : parameters,
  expectedStateVersion: fresh.stateVersion, reason: "用户在设备列表测试动作", dryRun };
 let result: ActionResult;
 try {
  const actionReceipt = await request<Record<string, unknown>>(root + "/action-requests", { method: "POST",
   headers: { "content-type": "application/json", "Idempotency-Key": key,
    "x-rabiroute-expected-application-generation-id": before.applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": before.managerInstanceId }, body: JSON.stringify(body) });
  result = { idempotencyKey: key, state: "completed", receipt: actionReceipt };
 } catch (error) {
  if (error instanceof RequestFailure && [400,403,412,422].includes(error.status)) result = { idempotencyKey: key, state: "failed", error: error.message };
  else { try { result = await receipt(key); } catch { result = { idempotencyKey: key, state: "uncertain", error: String(error) }; } }
 }
 try { if (!sameIdentity(before, await identity())) result.state = "uncertain"; }
 catch { result.state = "uncertain"; }
 return result;
}
export const homeDeviceClient = { directory: () => request<DeviceDirectory>(root + "/devices"),
 capabilities: () => request<{ actions: Array<{ capability: string; argumentsSchema?: Record<string, unknown> }> }>(root + "/capabilities"), inspect, execute, receipt };

export type VacuumVideoSession = { sessionId?: string; deviceId?: string; region?: string; state: "idle" | "connecting" | "streaming" | "failed" | "stopped"; error?: string; firstFrameAt?: string; frameBytes?: number; expiresAt?: string; connectionMode?: "local" | "relay"; audio: false };
export type VacuumVideoNetwork = { localAddress: string; onLinkInterfacePresent: boolean; observedAt: string };
async function videoWrite(command: "start" | "stop", body: Record<string, string | boolean>, key: string): Promise<VacuumVideoSession> {
 const before = await identity();
 let value: VacuumVideoSession;
 try { value = await request<VacuumVideoSession>(root + "/vacuum-cloud/video/" + command, { method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", "Idempotency-Key": key,
   "x-rabiroute-expected-application-generation-id": before.applicationGenerationId, "x-rabiroute-expected-manager-instance-id": before.managerInstanceId } });
 } catch (cause) {
  if (cause instanceof RequestFailure && cause.status < 500) throw cause;
  // A failed write is reconciled only through its original receipt/session; no new start key is generated here.
  value = await request<VacuumVideoSession>(root + "/vacuum-cloud/video/status?" + new URLSearchParams(command === "start" ? { idempotencyKey: key } : { sessionId: String(body.sessionId!) }));
 }
 if (!sameIdentity(before, await identity())) throw Error("运行版本已变化，请查询视频会话状态。");
 return value;
}
async function currentVideo(deviceId: string): Promise<VacuumVideoSession | undefined> {
 const before = await identity();
 const value = await request<VacuumVideoSession>(root + "/vacuum-cloud/video/status");
 if (!sameIdentity(before, await identity())) throw Error("运行版本已变化，请重新查询视频会话。");
 if (!value.sessionId || value.state === "idle" || value.state === "stopped") return;
 if (value.deviceId !== deviceId || value.region !== "cn") {
  if (value.state === "connecting" || value.state === "streaming") throw Error("另一台设备的视频正在连接，请先退出该设备的视频。");
  return;
 }
 return value;
}
export const vacuumVideoClient = {
 current: currentVideo,
 network: (deviceId: string) => request<VacuumVideoNetwork>(root + "/vacuum-cloud/video/network?" + new URLSearchParams({deviceId,region:"cn"})),
 start: (deviceId: string, key: string, password?: string, rememberPassword = false) => videoWrite("start", {deviceId, region:"cn", rememberPassword, ...(password ? {password} : {})}, key),
 passwordStatus: (deviceId: string) => request<{saved:boolean}>(root + "/vacuum-cloud/video/password?" + new URLSearchParams({deviceId,region:"cn"})),
 forgetPassword: async (deviceId: string, key: string) => {
  const before = await identity();
  let result: {state:string;saved:boolean};
  try { result = await request(root + "/vacuum-cloud/video/password/forget", {method:"POST", body:JSON.stringify({deviceId,region:"cn"}), headers:{"Content-Type":"application/json","Idempotency-Key":key,"x-rabiroute-expected-application-generation-id":before.applicationGenerationId,"x-rabiroute-expected-manager-instance-id":before.managerInstanceId}}); }
  catch(cause) { if(cause instanceof RequestFailure && cause.status < 500) throw cause; result = await request(root + "/vacuum-cloud/video/password?" + new URLSearchParams({idempotencyKey:key})); }
  if (!sameIdentity(before, await identity()) || result.state !== "completed") throw Error("删除结果尚未确认，请查询保存状态。");
  return result;
 },
 stop: (sessionId: string) => videoWrite("stop", {sessionId}, "video-stop-" + sessionId),
 status: (sessionId: string, signal?: AbortSignal) => request<VacuumVideoSession>(root + "/vacuum-cloud/video/status?" + new URLSearchParams({sessionId}), signal ? {signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])} : {}),
 streamUrl: (sessionId: string) => root + "/vacuum-cloud/video/stream?" + new URLSearchParams({sessionId})
};
/** The verified pv11cn video switch is a control entity, not a video stream. */
export function vacuumVideoSwitch(device: DeviceDirectory["devices"][number] | undefined): DeviceResource | undefined {
 if (device?.model !== "xiaomi.vacuum.pv11cn") return;
 return device.resources.find(item => item.kind === "switch" && /^switch\.xiaomi_[a-z]{2}_\d{1,32}_pv11cn_on_p_21_6$/.test(item.entityId));
}
export function deviceIcon(resources: readonly DeviceResource[]): string {
 const icons: Record<string, string> = { vacuum: "mdi-robot-vacuum", media_player: "mdi-speaker", climate: "mdi-air-conditioner", fan: "mdi-fan", light: "mdi-lightbulb-outline", cover: "mdi-curtains", switch: "mdi-power-socket-eu", sensor: "mdi-gauge", binary_sensor: "mdi-motion-sensor" };
 const priority = ["vacuum", "media_player", "climate", "fan", "light", "cover", "switch", "binary_sensor", "sensor"];
 return icons[priority.find(kind => resources.some(item => item.kind === kind)) || ""] || "mdi-devices";
}
export function parameterDefaults(schema: Record<string, any>): Record<string, unknown> {
 const result: Record<string, unknown> = {};
 for (const [name, raw] of Object.entries(schema.properties || {})) {
  const value = raw as Record<string, any>;
  if (value.const !== undefined) result[name] = value.const;
  else if ((schema.required || []).includes(name)) {
   if (value.enum?.length) result[name] = value.enum[0];
   else if (value.type === "array") result[name] = (value.prefixItems || []).map((item: any) => item.const ?? item.enum?.[0] ?? (item.type === "boolean" ? false : ["number", "integer"].includes(item.type) ? item.minimum ?? 0 : ""));
   else if (value.type === "boolean") result[name] = false;
   else if (["number", "integer"].includes(value.type)) result[name] = value.minimum ?? 0;
   else result[name] = "";
  }
 }
 return result;
}

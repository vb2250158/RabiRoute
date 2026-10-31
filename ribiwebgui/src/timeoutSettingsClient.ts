import { configureTimeouts, getTimeoutMs } from "../../src/shared/timeoutSettings";
export { getTimeoutMs };
export type TimeoutCatalogEntry = { key: string; defaultMs: number; label: string; scope: string; effect: string };
export type TimeoutSettings = { overrides: Record<string, number>; catalog: TimeoutCatalogEntry[]; etag?: string };

async function requestSettings(init: RequestInit = {}, request: typeof fetch = (...args) => fetch(...args)): Promise<TimeoutSettings> {
  const deadline = AbortSignal.timeout(getTimeoutMs("webgui.timeouts.request", 5000));
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await request("/api/rabi/timeouts", { ...init, cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.data || !Array.isArray(body.data.catalog) || !body.data.overrides) {
    throw new Error(response.status === 412 ? "设置已被其他页面修改，请重新加载后再保存。当前草稿已保留。" : body.message || "无法读取超时设置，请重试。");
  }
  return { ...body.data, etag: response.headers.get("etag") || undefined };
}
export async function loadTimeoutSettings(request?: typeof fetch): Promise<TimeoutSettings> {
  const result = await requestSettings({}, request);
  configureTimeouts(result.overrides);
  return result;
}
export async function saveTimeoutSettings(baseline: Record<string, number>, draft: Record<string, number>, request?: typeof fetch): Promise<TimeoutSettings> {
  for (const value of Object.values(draft)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("超时必须是 1 到 2147483647 之间的整数毫秒。");
  }
  const changed = [...new Set([...Object.keys(baseline), ...Object.keys(draft)])].filter(key => baseline[key] !== draft[key]);
  const latest = await requestSettings({}, request);
  const overrides = { ...latest.overrides };
  for (const key of changed) {
    if (latest.overrides[key] !== baseline[key] && latest.overrides[key] !== draft[key]) throw new Error("此项超时已被其他页面修改，请重新加载后再保存。");
    if (draft[key] === undefined) delete overrides[key];
    else overrides[key] = draft[key];
  }
  if (!latest.etag) throw new Error("服务未提供配置版本，请更新服务后再保存。");
  await requestSettings({ method: "PATCH", headers: { "content-type": "application/json", "if-match": latest.etag }, body: JSON.stringify({ overrides }) }, request);
  const result = await loadTimeoutSettings(request);
  if (changed.some(key => result.overrides[key] !== draft[key])) throw new Error("设置回读不一致，请重新加载核对。");
  return result;
}

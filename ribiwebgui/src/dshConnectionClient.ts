export type DshConnectionState = "connected" | "saved" | "disconnected" | "not_connected" | "expired" | "unavailable" | "legacy";
export type DshConnection = { baseUrl: string; state: DshConnectionState; expiresAt?: number; message?: string };
const endpoint = "/api/agent-adapters/dsh/connection";

export function isLocalDshSetupPage(location: Pick<Location, "hostname" | "pathname">): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && !/relay|rabilink/i.test(location.pathname);
}
export function cleanDshOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请选择不含登录凭据的 DSH 地址。");
  }
  return url.origin;
}
export function dshConnectionLabel(state?: DshConnectionState): string {
  return ({ connected: "连接验证通过", saved: "已保存授权（未检测在线状态）", disconnected: "已移除授权", not_connected: "尚未连接", expired: "授权已过期", unavailable: "连接不可用", legacy: "现有连接需要更新" })[state ?? "not_connected"];
}
export function createDshConnectionClient(request: typeof fetch = fetch) {
  let revision: number | undefined;
  async function call(url: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try { response = await request(url, { ...init, redirect: "error" }); }
    catch { throw new Error("无法确认操作结果。请刷新连接状态后再决定是否重试，不要重复提交。"); }
    // Never echo server errors: they can contain a submitted login URL.
    if (!response.ok) {
      const messages: Record<number, string> = {
        403: "请在运行 RabiRoute 的电脑上打开本机控制台完成授权。",
        409: "连接设置已被其他操作更新。请刷新状态后再决定是否重新提交。",
        401: "DSH 授权已失效，请使用当前登录链接重新连接。",
        413: "登录链接过长，请仅粘贴 DSH 提供的登录地址。"
      };
      throw new Error(messages[response.status] || "连接操作未完成。请确认 DSH 已启动，并使用当前登录链接；先刷新状态再重试。");
    }
    let body: any;
    try { body = await response.json(); } catch { throw new Error("无法读取连接结果，请刷新连接状态。"); }
    if (body?.ok !== true) throw new Error("连接操作未完成，请刷新状态并检查 DSH 是否已启动。");
    if (Number.isSafeInteger(body.revision)) revision = body.revision;
    return body;
  }
  function connection(value: DshConnection): DshConnection {
    const baseUrl = cleanDshOrigin(value.baseUrl);
    if (!["connected", "saved", "disconnected", "not_connected", "expired", "unavailable", "legacy"].includes(value.state)) throw new Error("无法识别连接状态，请更新 RabiRoute。");
    return { baseUrl, state: value.state, expiresAt: value.expiresAt };
  }
  return {
    async list(): Promise<DshConnection[]> { return (await call(`${endpoint}s`)).endpoints.map(connection); },
    async status(baseUrl: string): Promise<DshConnection> { return connection((await call(`${endpoint}?baseUrl=${encodeURIComponent(cleanDshOrigin(baseUrl))}`)).connection); },
    async connect(input: { launchUrl?: string; baseUrl?: string }): Promise<DshConnection> {
      return connection((await call(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, expectedRevision: revision }) })).connection);
    },
    async disconnect(baseUrl: string): Promise<void> { await call(endpoint, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: cleanDshOrigin(baseUrl), expectedRevision: revision }) }); }
  };
}

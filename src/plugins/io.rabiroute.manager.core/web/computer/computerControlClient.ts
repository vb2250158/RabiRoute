import { peerManagerPath } from "../../../../../ribiwebgui/src/peerManagerTarget";
import type { ComputerTarget } from "./computerControlPresentation";
import type { ComputerDirectorySnapshot, ComputerSettingsSnapshot } from "./computerControlState";
function computerErrorMessage(body: Record<string, unknown>, status: number): string {
 const error = body.error;
 const reason = typeof body.message === "string" && body.message || typeof error === "string" && error || error && typeof error === "object" && typeof (error as Record<string,unknown>).message === "string" && String((error as Record<string,unknown>).message) || `请求失败：HTTP ${status}`;
 const parts = [reason, typeof body.errorCode === "string" ? body.errorCode : "", typeof body.field === "string" ? `Field: ${body.field}` : "", typeof body.repair === "string" ? body.repair : typeof body.nextAction === "string" ? body.nextAction : ""];
 return parts.filter(Boolean).join("\n");
}
function settingsPatchMatches(patch:Record<string,unknown>, settings:Record<string,unknown>):boolean {
 return Object.entries(patch).every(([key,value])=>value && typeof value === "object" && !Array.isArray(value)
  ? !!settings[key] && typeof settings[key] === "object" && !Array.isArray(settings[key]) && settingsPatchMatches(value as Record<string,unknown>,settings[key] as Record<string,unknown>)
  : JSON.stringify(value) === JSON.stringify(settings[key]));
}
export class ComputerControlRequestError extends Error { constructor(message: string, readonly status: number, readonly payload: unknown) { super(message); } }
export class ComputerControlClient {
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis), private readonly token = "") {}
  private async json(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); if (this.token) headers.set("x-rabiroute-webgui-token", this.token);
    const response = await this.request(path, { ...init, cache: "no-store", headers });
    const body = await response.json();
    if (!response.ok || (body.code !== undefined && body.code !== 0)) throw new ComputerControlRequestError(computerErrorMessage(body, response.status), response.status, body);
    return { response, body };
  }
  async list(signal: AbortSignal): Promise<ComputerDirectorySnapshot> {
    const { body } = await this.json("/api/computers", { signal });
    const directory = body.data as ComputerDirectorySnapshot;
    return { ...directory, computers:directory.computers.map(row=>({...row,name:row.name || (row as unknown as {hostname?:string}).hostname || (row.kind === "host" ? "未命名主机" : "未命名电脑")})) };
  }
  private path(target: ComputerTarget, suffix: string) { return peerManagerPath(target.ownerDeviceId || "", `/api/lan-agent/instances/${encodeURIComponent(target.instanceId)}${suffix}`); }
  async settings(target: ComputerTarget, signal?: AbortSignal): Promise<ComputerSettingsSnapshot> {
    const { response, body } = await this.json(this.path(target, "/computer-settings"), { signal });
    return { ...body.data, etag: response.headers.get("etag") || "" };
  }
  async saveSettings(target: ComputerTarget, patch: Record<string, unknown>, etag: string): Promise<ComputerSettingsSnapshot> {
    const committed = await this.json(this.path(target, "/computer-settings"), { method: "PATCH", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify(patch) });
    const applied = committed.body.data as ComputerSettingsSnapshot;
    const application = {execution:applied.execution,executionIssue:applied.executionIssue,executionRevision:applied.revision};
    try { const current=await this.settings(target);return {...current,...application,...(!settingsPatchMatches(patch,current.settings)?{readbackMismatch:true,readbackIssue:"修改已提交；回读值与本次修改不一致，请核对最新状态后再决定是否重新应用。"}:{})}; }
    catch { return {...applied,...application,etag:committed.response.headers.get("etag") || String(applied.revision || ""),readbackIssue:"设置已保存；后续读取暂未确认。请刷新读取，不要重复提交。"}; }
  }

  async resetSettings(target: ComputerTarget, paths: readonly string[], etag: string): Promise<ComputerSettingsSnapshot> {
    const committed = await this.json(this.path(target,"/computer-settings/reset"), {
      method:"POST",headers:{"content-type":"application/json","if-match":etag},body:JSON.stringify({paths})
    });
    const applied=committed.body.data as ComputerSettingsSnapshot;
    const application={execution:applied.execution,executionIssue:applied.executionIssue,executionRevision:applied.revision};
    try {
      const current=await this.settings(target);
      const raw=current.rawSettings;
      const remains=paths.some(pathname=>{
        let item:unknown=raw;
        for(const key of pathname.split(".")){if(!item||typeof item!=="object"||!Object.hasOwn(item,key))return false;item=(item as Record<string,unknown>)[key];}
        return true;
      });
      return {...current,...application,...(remains?{readbackMismatch:true,readbackIssue:"恢复默认已提交；回读仍有选中覆盖值，请核对最新状态，不要重复提交。"}:{})};
    } catch {return {...applied,...application,etag:committed.response.headers.get("etag")||String(applied.revision||""),readbackIssue:"恢复默认已提交；后续读取暂未确认。请刷新读取，不要重复提交。"};}
  }

  async action(target: ComputerTarget, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.json(this.path(target, "/computer"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    return result.body.data;
  }
}

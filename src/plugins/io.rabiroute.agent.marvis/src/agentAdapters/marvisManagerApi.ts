import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {getTimeoutMs} from '@rabiroute/host-api/shared/timeoutSettings';
import type {AgentManagerApiContext,AgentScanOptions,AgentScanResult,AgentScanSession,AgentSessionPage,AgentScanProject,AgentScanPerformanceOperation,CopilotSessionEntry,AstrbotSessionScan,AstrbotLoginTestRequest,MarvisOpenRequest} from '@rabiroute/host-api/agentAdapters/managerTypes';
import {agentScanManifestFields,getRuntimeList,projectOptionsFromPaths,normalizeComparablePath,checkHttpEndpoint,collectAgentCwdOptions} from '@rabiroute/host-api/agentAdapters/managerScanShared';
export function detectMarvisAppIds(): string[] {
  const marvisAppIds = ["Tencent.Marvis"];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    for (const base of [appData, localAppData]) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().includes("marvis")) {
            marvisAppIds.push(entry.name);
          }
        }
      } catch {
        // skip
      }
    }
  }
  return marvisAppIds;
}
export function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}
export function openUrlWithDefaultApp(url: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}
export function openMarvis(_ctx: AgentManagerApiContext, request: MarvisOpenRequest): Record<string, unknown> {
  const appId = request.appId?.trim() || process.env.MARVIS_APP_ID?.trim() || "Tencent.Marvis";
  const url = request.url?.trim() || process.env.MARVIS_URL?.trim() || "https://marvis.qq.com/";
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [`shell:AppsFolder\\${appId}`]);
    return { ok: true, mode: "desktop", target: appId, message: `已尝试打开 Marvis 应用：${appId}` };
  }

  openUrlWithDefaultApp(url);
  return { ok: true, mode: "url", target: url, message: `已尝试打开 Marvis 页面：${url}` };
}
export async function scanMarvisAgentAdapter(ctx:AgentManagerApiContext) {const marvisAppIds=ctx.marvisAppIds??detectMarvisAppIds();return {agents:{marvis:{
      ...agentScanManifestFields("marvis",ctx.manifest),
      installed: marvisAppIds.length > 0,
      installCandidates: marvisAppIds.map((id) => ({ label: id })),
      warnings: [
        "当前 Marvis 适配更像打开 App/复制 prompt 的人工接力，不是可靠的线程消息注入。",
        "不能列会话、不能创建会话，也不能验证同会话重复注入；不要标为 verified。"
      ]
    }},cwdOptions:[],marvisAppIds};}

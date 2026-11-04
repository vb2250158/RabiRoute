import fs from 'node:fs';
import path from 'node:path';
import {getTimeoutMs} from '../shared/timeoutSettings.js';
import {resolvePersistedProjectPath} from '../shared/projectPaths.js';
import {agentAdapterManifest} from '../shared/agentAdapterCapabilities.js';
import type {AgentAdapterDescriptor} from '@rabiroute/plugin-sdk';
import type {AgentAdapterType} from './types.js';
import type {AgentManagerApiContext,AgentScanResult,AgentScanRuntimeSnapshot,AgentScanProject} from './managerTypes.js';
export function agentScanManifestFields(type: AgentAdapterType, supplied?: AgentAdapterDescriptor): Pick<
  AgentScanResult,
  "type" | "label" | "maturity" | "transport" | "host"
> {
  const manifest = supplied ?? agentAdapterManifest(type);
  return {
    type: manifest.type,
    label: manifest.label,
    maturity: manifest.maturity,
    transport: { ...manifest.transport },
    ...(manifest.host ? { host: { ...manifest.host } } : {})
  };
}
export function getRuntimeList(ctx: AgentManagerApiContext): AgentScanRuntimeSnapshot[] {
  const source = ctx.getRuntimes ? ctx.getRuntimes() : ctx.runtimes;
  return source ? [...source] : [];
}
export function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export function projectOptionsFromPaths(paths: string[]): AgentScanProject[] {
  const byNormalized = new Map<string, AgentScanProject>();
  for (const item of paths) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = normalizeComparablePath(trimmed);
    if (!normalized || byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, {
      label: path.basename(trimmed) || trimmed,
      path: trimmed,
      exists: fs.existsSync(trimmed)
    });
  }
  return [...byNormalized.values()];
}
export async function checkHttpEndpoint(url: string, timeoutMs = getTimeoutMs("agent.endpointProbe", 1200)): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export function collectAgentCwdOptions(rootDir: string,runtimes: AgentScanRuntimeSnapshot[],fields: readonly string[],sessions: readonly {cwd?:string}[]=[]): string[] {
 const values=new Set(sessions.flatMap(session=>session.cwd&&fs.existsSync(session.cwd)?[session.cwd]:[]));
 if(fs.existsSync(rootDir))values.add(rootDir);
 for(const runtime of runtimes)for(const key of fields){const raw=(runtime.definition as unknown as Record<string,unknown>)[key];const value=typeof raw==='string'?resolvePersistedProjectPath(raw,rootDir):undefined;if(value&&fs.existsSync(value))values.add(value);}
 try{for(const entry of fs.readdirSync(path.dirname(rootDir),{withFileTypes:true}))if(entry.isDirectory())values.add(path.join(path.dirname(rootDir),entry.name));}catch{}
 return [...values];
}

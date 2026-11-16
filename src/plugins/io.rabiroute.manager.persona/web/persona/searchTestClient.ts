import type { GatewayDefinition } from '@shared/gatewayConfigModel';
import { resolvePrimaryAgentTarget } from '@shared/routeAgentTargets';
import type { WebRendererContribution } from '../../../../../ribiwebgui/src/pluginRenderers';

export type SearchTestIdentity = {
  key: string;
  label: string;
  agentType: string;
  sessionId: string;
};

/** Session references come from the selected target's original adapter presentation. */
export function searchTestIdentities(roleId: string, routes: readonly GatewayDefinition[], renderers: readonly WebRendererContribution[]) {
  const identities: SearchTestIdentity[] = [{ key: 'role', label: roleId, agentType: 'role', sessionId: roleId }];
  const warnings: string[] = [];
  for (const route of routes) {
    if (route.agentRoleDeviceId || route.agentRoleId !== roleId) continue;
    try {
      const target = resolvePrimaryAgentTarget(route);
      if (!target) continue;
      const session = target.binding ? target
        : renderers.find(renderer => renderer.agentType === target.provider)?.agentRoute?.session?.(route);
      identities.push({ key: `${route.id}:${target.id}`, label: `${route.routeName || route.name || route.id} · ${target.provider}`,
        agentType: target.provider, sessionId: session?.sessionId?.trim() || '' });
    } catch (error) {
      warnings.push(`${route.routeName || route.name || route.id} · ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { identities, warnings };
}

export type SearchTestBody = {
  code?: number;
  requestId?: string;
  message?: string;
  data?: {
    items?: { source: string; kind: string; label: string; excerpt: string; handle?: unknown }[];
    coverage?: { state: string; [key: string]: unknown };
    degraded?: unknown[];
    warnings?: unknown[];
    nextCursor?: string | null;
  };
};
export type SearchTestReceipt = {
  request: { method: string; url: string; headers: Record<string, string> };
  status: number;
  durationMs: number;
  body: SearchTestBody;
};

/** Tests the real search entry. Caller metadata and query scope remain explicit. */
export async function runSearchTest(request: typeof fetch, parameters: string, identity: Pick<SearchTestIdentity, 'agentType' | 'sessionId'>, signal: AbortSignal): Promise<SearchTestReceipt> {
  const input = JSON.parse(parameters);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('查询参数需要是 JSON 对象。');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) query.set(key, Array.isArray(value) ? value.join(',') : typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (identity.agentType.trim()) headers['x-rabiroute-agent-type'] = identity.agentType.trim();
  if (identity.sessionId.trim()) headers['x-rabiroute-session-id'] = identity.sessionId.trim();
  const url = '/api/search?' + query;
  const began = performance.now();
  const response = await request(url, { headers, signal });
  const text = await response.text();
  let body: SearchTestBody;
  try { body = JSON.parse(text); }
  catch { body = { message: text || response.statusText }; }
  return { request: { method: 'GET', url, headers }, status: response.status, durationMs: Math.round(performance.now() - began), body };
}

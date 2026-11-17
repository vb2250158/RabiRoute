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

export type SearchTestItem = {
  source: string;
  kind: string;
  label: string;
  excerpt: string;
  agent?: string | null;
  origin?: Record<string, unknown>;
  observedAt?: number | null;
  updatedAt?: string;
  status?: string;
  detailUrl?: string;
  handle?: { detailUrl?: string; contractUrl?: string; operationId?: string; [key: string]: unknown };
};
export type SearchTestSource = {
  source: string;
  status: string;
  returned: number;
  hasMore?: boolean | null;
  coverage?: { agent?: string | null; complete?: boolean; gaps?: unknown[] }[];
};
export type SearchTestBody = {
  code?: number;
  requestId?: string;
  message?: string;
  data?: {
    items?: SearchTestItem[];
    coverage?: { state: string; sources?: SearchTestSource[]; notQueried?: unknown[]; [key: string]: unknown };
    degraded?: { source: string; errorCode?: string; message?: string; agent?: string | null }[];
    warnings?: unknown[];
    nextCursor?: string | null;
  };
};

export function parseSearchTestParameters(parameters: string): Record<string, unknown> {
  const input = JSON.parse(parameters);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('查询参数需要是 JSON 对象。');
  return input;
}

/** Only adjacent messages with the same title and conversation are visually grouped. */
export function searchTestResultGroups(items: readonly SearchTestItem[]) {
  const groups: { item: SearchTestItem; indexes: number[] }[] = [];
  items.forEach((item, index) => {
    const previous = groups.at(-1);
    if (item.source === 'messages' && previous?.item.source === item.source
      && previous.item.label === item.label && previous.item.kind === item.kind
      && previous.item.agent === item.agent
      && previous.item.origin?.conversationKey === item.origin?.conversationKey) {
      previous.indexes.push(index);
    } else {
      groups.push({ item, indexes: [index] });
    }
  });
  return groups;
}

export function searchTestHighlights(text: string, query: string) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!terms.length) return [{ text, matched: false }];
  const pattern = new RegExp('(' + terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return text.split(pattern).filter(Boolean).map((part, index) => ({ text: part, matched: terms.some(term => term.toLowerCase() === part.toLowerCase()) }));
}
export type SearchTestReceipt = {
  request: { method: string; url: string; headers: Record<string, string> };
  status: number;
  durationMs: number;
  body: SearchTestBody;
};

/** Tests the real search entry. Caller metadata and query scope remain explicit. */
export async function runSearchTest(request: typeof fetch, parameters: string, identity: Pick<SearchTestIdentity, 'agentType' | 'sessionId'>, signal: AbortSignal): Promise<SearchTestReceipt> {
  const input = parseSearchTestParameters(parameters);
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

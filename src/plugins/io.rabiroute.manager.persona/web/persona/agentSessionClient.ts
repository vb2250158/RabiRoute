import type { GatewayDefinition } from '@shared/gatewayConfigModel';
import { normalizeRouteAgentTargets, type RouteAgentTarget } from '@shared/routeAgentTargets';
import { normalizeAgentInstanceBinding } from '@shared/agentInstance';
import { postRouteAgentThreadAction } from '../../../../../ribiwebgui/src/routeAgentThreadClient';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';

export type PersonaSessionAgent = RouteAgentTarget & { key: string; dshBaseUrl?: string; routes: string[] };
export type PersonaAgentTask = { id: string; title: string; cwd?: string; updatedAt?: string; archived?: boolean };

/** Use the selected persona owner's configured Routes, including disconnected saved targets. */
export function personaSessionAgents(routes: readonly GatewayDefinition[], roleId: string): PersonaSessionAgent[] {
  const agents = new Map<string, PersonaSessionAgent>();
  for (const route of routes) {
    if (route.agentRoleDeviceId || route.agentRoleId !== roleId) continue;
    const configured = normalizeRouteAgentTargets(route);
    const targets: RouteAgentTarget[] = [
      ...configured.agentAdapters.map(provider => ({ id: `local:${provider}`, provider })),
      ...configured.remoteAgentTargets.map(target => ({ ...target, binding: normalizeAgentInstanceBinding(target) }))
    ];
    for (const target of targets) {
      const dshBaseUrl = target.provider === 'dsh' && !target.binding ? route.dshBaseUrl : undefined;
      const key = JSON.stringify([target.id, target.provider, dshBaseUrl ?? '']);
      const previous = agents.get(key);
      const name = route.routeName || route.name || route.id;
      if (previous) previous.routes = [...new Set([...previous.routes, name])];
      else agents.set(key, { ...target, key, dshBaseUrl, routes: [name] });
    }
  }
  return [...agents.values()];
}

export function createAgentSessionClient(request: typeof fetch, sourceDeviceId = '') {
  const execute = (agent: PersonaSessionAgent, payload: Record<string, unknown>, signal?: AbortSignal) =>
    postRouteAgentThreadAction({ ...payload, ...(agent.dshBaseUrl ? { dshBaseUrl: agent.dshBaseUrl } : {}) }, agent,
      { fetch: request, accessToken: () => '', signal });
  return {
    async agents(roleId: string, signal?: AbortSignal) {
      const response = await request(peerManagerPath(sourceDeviceId, '/gateways?summary=1&includeConfig=1'), { signal });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.config?.gateways)) {
        throw new Error(body.message || '角色 Agent 端配置读取失败。');
      }
      return personaSessionAgents(body.data.config.gateways, roleId);
    },
    async tasks(agent: PersonaSessionAgent, query: string, offset = 0, signal?: AbortSignal) {
      const body = await execute(agent, { action: 'list', query, offset, limit: 50 }, signal);
      if (!Array.isArray(body.threads)) throw new Error('Agent 端未返回会话列表。');
      return { items: body.threads as PersonaAgentTask[], nextOffset: body.nextOffset as number | null ?? null };
    },
    async history(agent: PersonaSessionAgent, taskId: string, cursor?: string, signal?: AbortSignal) {
      // These published APIs read the native transcript on the selected PC owner.
      // An enrolled LAN Agent retains its instance-scoped operation below.
      const nativeProvider = agent.provider === 'codex' || agent.provider === 'dsh' && !agent.dshBaseUrl;
      if (nativeProvider && (!agent.binding || agent.binding.ownerDeviceId)) {
        const query = agent.provider === 'codex'
          ? new URLSearchParams({ limit: '200', maxBytes: '2097152', ...(cursor ? { cursor } : {}) })
          : new URLSearchParams({ maxMessages: '200', ...(cursor ? { beforeSeq: cursor } : {}) });
        const path = `/api/agent/providers/${agent.provider}/sessions/${encodeURIComponent(taskId)}/history?${query}`;
        const response = await request(peerManagerPath(agent.binding?.ownerDeviceId ?? '', path), { signal });
        const body = await response.json();
        if (!response.ok || body.code !== 0 || !body.data) {
          throw new Error(body.message || body.error?.message || 'Agent 会话历史读取失败。');
        }
        return body.data as Record<string, any>;
      }
      const body = await execute(agent, { action: 'read', threadId: taskId, history: { limit: 200, ...(cursor ? { cursor } : {}) } }, signal);
      if (!body.history) throw new Error('该 Agent 端尚未提供会话历史读取能力。');
      return body.history as Record<string, any>;
    }
  };
}

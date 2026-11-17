import { agentMessagePreview } from '@shared/agentSessionMessages';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor } from './agentSessionHistory';
import type { GatewayDefinition } from '@shared/gatewayConfigModel';
import { normalizeRouteAgentTargets, type RouteAgentTarget } from '@shared/routeAgentTargets';
import { normalizeAgentInstanceBinding } from '@shared/agentInstance';
import { postRouteAgentThreadAction } from '../../../../../ribiwebgui/src/routeAgentThreadClient';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';

export type PersonaSessionAgent = RouteAgentTarget & { key: string; dshBaseUrl?: string; routes: string[] };
export type PersonaAgentTask = { id: string; title: string; cwd?: string; updatedAt?: string; archived?: boolean; parentThreadId?:string; agentNickname?:string; agentRole?:string; preview?:string; previewUnavailable?:boolean; lastMessageTime?:string };

export function agentSessionMembersAvailable(agent:PersonaSessionAgent|undefined):boolean {
  return Boolean(agent?.provider === 'codex' && (!agent.binding || agent.binding.ownerDeviceId));
}

/** Project identity follows the owner's working directory, including Windows extended paths. */
export function agentSessionProject(cwd = ''): { key: string; title: string; path: string } {
  let path = cwd.trim().replaceAll('\\', '/');
  if (path.toLowerCase().startsWith('//?/unc/')) path = '//' + path.slice(8);
  else if (path.startsWith('//?/')) path = path.slice(4);
  if (path !== '/' && !/^[a-z]:\/$/i.test(path)) path = path.replace(/\/+$/, '');
  const windowsPath = /^[a-z]:\//i.test(path) || path.startsWith('//');
  return { key: windowsPath ? path.toLowerCase() : path, title: path.split('/').filter(Boolean).at(-1) || path, path };
}

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
  const previewCache = new Map<string,{preview:string;lastMessageTime?:string}>();
  async function readHistory(agent: PersonaSessionAgent, taskId: string, cursor?: string, signal?: AbortSignal) {

      // These published APIs read the native transcript on the selected PC owner.
      // An enrolled LAN Agent retains its instance-scoped operation below.
      const nativeProvider = agent.provider === 'codex' || agent.provider === 'dsh' && !agent.dshBaseUrl;
      if (nativeProvider && (!agent.binding || agent.binding.ownerDeviceId)) {
        const query = agent.provider === 'codex'
          ? new URLSearchParams({ view:'messages', limit: '200', maxBytes: '2097152', ...(cursor ? { cursor } : {}) })
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
  async function taskPreview(agent:PersonaSessionAgent,task:PersonaAgentTask,signal?:AbortSignal) {
        const key = JSON.stringify([agent.key,task.id,task.updatedAt]);
        const cached = task.updatedAt ? previewCache.get(key) : undefined;
        if (cached) return {...task,...cached};
        try {
          let cursor:string|undefined, latest:ReturnType<typeof agentHistoryMessages>[number]|undefined;
          for (;;) {
            const page = await readHistory(agent,task.id,cursor,signal);
            latest = agentHistoryMessages(agent.provider,agentHistoryEvents(agent.provider,page)).at(-1) || latest;
            const next = agentHistoryNextCursor(agent.provider,page);
            if (agent.provider === 'dsh' && latest || next === null) break;
            if (next === cursor) throw new Error('历史分页位置未前进。');
            cursor = next;
          }
          if (!latest) return task;
          const summary = {preview:agentMessagePreview(latest.text),lastMessageTime:latest.time};
          if (task.updatedAt) previewCache.set(key,summary);
          if (previewCache.size>256) previewCache.delete(previewCache.keys().next().value!);
          return {...task,...summary};
        } catch {
          signal?.throwIfAborted();
          return {...task,previewUnavailable:true};
        }
  }
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
      if (agentSessionMembersAvailable(agent)) {
        const queryString = new URLSearchParams({view:'roots',previews:'1',query,offset:String(offset),limit:'50'});
        const response = await request(peerManagerPath(agent.binding?.ownerDeviceId ?? '', '/api/agent/providers/codex/sessions?'+queryString), {signal});
        const body = await response.json();
        if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(body.message || 'Agent 端未返回会话列表。');
        return {items:body.data.items as PersonaAgentTask[],nextOffset:body.data.nextOffset as number|null ?? null};
      }
      const body = await execute(agent, { action: 'list', query, offset, limit: 50 }, signal);
      if (!Array.isArray(body.threads)) throw new Error('Agent 端未返回会话列表。');
      const items = body.threads as PersonaAgentTask[];
      return { items, nextOffset: body.nextOffset as number | null ?? null };
    },
    async previews(agent:PersonaSessionAgent,items:PersonaAgentTask[],onPreview:(task:PersonaAgentTask)=>void,signal?:AbortSignal) {
      if (!['dsh','workbuddy'].includes(agent.provider)) return;
      let index=0;
      await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
        while(index<items.length) {
          signal?.throwIfAborted();
          const task=items[index++];
          const summary=await taskPreview(agent,task,signal);
          signal?.throwIfAborted();
          onPreview(summary);
        }
      }));
    },
    async members(agent:PersonaSessionAgent,parentSessionId:string,offset=0,signal?:AbortSignal) {
      if (!agentSessionMembersAvailable(agent)) return {items:[] as PersonaAgentTask[],nextOffset:null};
      const query = new URLSearchParams({parentSessionId,previews:'1',offset:String(offset),limit:'50'});
      const response = await request(peerManagerPath(agent.binding?.ownerDeviceId ?? '', '/api/agent/providers/codex/sessions?'+query), {signal});
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(body.message || '子 Agent 列表读取失败。');
      return {items:body.data.items as PersonaAgentTask[],nextOffset:body.data.nextOffset as number|null ?? null};
    },
    history:readHistory
  };
}

import { agentMessagePreview } from '@shared/agentSessionMessages';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor } from '../../../../../ribiwebgui/src/agentSessionHistory';
import type { GatewayDefinition } from '@shared/gatewayConfigModel';
import { normalizeRouteAgentTargets, type RouteAgentTarget } from '@shared/routeAgentTargets';
import { normalizeAgentInstanceBinding } from '@shared/agentInstance';
import { postRouteAgentThreadAction } from '../../../../../ribiwebgui/src/routeAgentThreadClient';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';

export type AgentNodeKind = 'local' | 'peer' | 'instance';
/** One selectable session source: this Manager, a RabiLink computer, or an enrolled LAN Agent instance. */
export type AgentNode = {
  id: string; kind: AgentNodeKind; name: string; online: boolean;
  deviceId?: string; instanceId?: string; detail?: string; latencyMs?: number | null;
  agents?: ReadonlyArray<{ agentId: string; name: string; provider: string; enabled?: boolean; routeId?: string; workspace?: string }>;
};
export type PersonaSessionAgent = RouteAgentTarget & { key: string; dshBaseUrl?: string; routes: string[]; label?: string; nodeId?: string; nodeName?: string; nodeKind?: AgentNodeKind };
export type PersonaAgentTask = { id: string; title: string; cwd?: string; updatedAt?: string; archived?: boolean; parentThreadId?:string; agentNickname?:string; agentRole?:string; preview?:string; previewUnavailable?:boolean; lastMessageTime?:string };

export function agentSessionMembersAvailable(agent:PersonaSessionAgent|undefined):boolean {
  return Boolean(agent?.provider === 'codex' && agent.nodeKind !== 'instance' && (!agent.binding || agent.binding.ownerDeviceId));
}

/** Remote nodes keep the same session layout, so only genuinely executable providers become tabs. */
export const remoteAgentProviders = ['codex', 'dsh', 'grokBot', 'workbuddy', 'antigravity', 'copilotCli'] as const;

export function agentNodeLabel(node: AgentNode): string {
  return node.name || node.deviceId || node.instanceId || node.id;
}

/** Instance Agent IDs must satisfy the shared binding contract before they can be selected. */
function bindableInstanceAgent(agentId: string): boolean {
  try { normalizeAgentInstanceBinding({ instanceId: 'instance', agentId }); return true; } catch { return false; }
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

export type AgentSessionClientOptions = { node?: () => AgentNode | undefined; candidates?: () => readonly string[] };

export function createAgentSessionClient(request: typeof fetch, sourceDeviceId = '', options: AgentSessionClientOptions = {}) {
  const node = () => options.node?.();
  const peerDevice = () => {
    const current = node();
    return current?.kind === 'peer' || current?.kind === 'instance' ? current.deviceId || '' : '';
  };
  /** Resolution order keeps an explicit peer/owner ahead of the persona source, never mixing them. */
  const targetPath = (owner: string | undefined, path: string) => peerManagerPath(peerDevice() || owner || sourceDeviceId || '', path);
  const peerFetch: typeof fetch = (input, init) => typeof input === 'string' ? request(targetPath(undefined, input), init) : request(input, init);
  /** Enrolled LAN instances keep their instance binding, but the peer Manager resolves it on its own computer. */
  async function postPeerThread(deviceId: string, payload: Record<string, unknown>, signal?: AbortSignal) {
    const response = await request(peerManagerPath(deviceId, '/api/agent/threads'), {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok || body.code === -1) throw new Error(body.message || '远端 Agent 会话操作失败。');
    return body as Record<string, any>;
  }
  const execute = (agent: PersonaSessionAgent, payload: Record<string, unknown>, signal?: AbortSignal) => {
    const remote = Boolean(peerDevice());
    if (agent.nodeKind === 'instance' && remote && agent.binding) {
      return postPeerThread(peerDevice(), { ...payload, agentAdapter: agent.provider,
        instanceBinding: { instanceId: agent.binding.instanceId, agentId: agent.binding.agentId } }, signal);
    }
    return postRouteAgentThreadAction(
      { ...payload, ...((!remote && agent.dshBaseUrl) ? { dshBaseUrl: agent.dshBaseUrl } : {}) },
      agent,
      { fetch: remote ? peerFetch : request, accessToken: () => '', signal }
    );
  };
  const previewCache = new Map<string,{preview:string;lastMessageTime?:string}>();
  async function readHistory(agent: PersonaSessionAgent, taskId: string, cursor?: string, signal?: AbortSignal) {

      // Native provider history reads the selected PC owner; enrolled LAN instances keep their instance operation.
      const nativeProvider = agent.nodeKind !== 'instance' && (agent.provider === 'codex' || agent.provider === 'dsh' && !agent.dshBaseUrl);
      if (nativeProvider && (!agent.binding || agent.binding.ownerDeviceId)) {
        const query = agent.provider === 'codex'
          ? new URLSearchParams({ view:'messages', limit: '200', maxBytes: '2097152', ...(cursor ? { cursor } : {}) })
          : new URLSearchParams({ maxMessages: '200', ...(cursor ? { beforeSeq: cursor } : {}) });
        const path = `/api/agent/providers/${agent.provider}/sessions/${encodeURIComponent(taskId)}/history?${query}`;
        const response = await request(targetPath(agent.binding?.ownerDeviceId, path), { signal });
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
  function providerPath(deviceId: string, path: string) {
    return deviceId ? peerManagerPath(deviceId, path) : path;
  }
  /** Probe each provider independently so one slow or missing adapter never hides the others. */
  async function providerHasSessions(deviceId: string, provider: string, signal?: AbortSignal): Promise<boolean> {
    try {
      if (provider === 'codex' || provider === 'dsh') {
        const query = provider === 'codex'
          ? new URLSearchParams({ view: 'roots', previews: '1', offset: '0', limit: '1' })
          : new URLSearchParams({ offset: '0', limit: '1' });
        const response = await request(providerPath(deviceId, `/api/agent/providers/${provider}/sessions?${query}`), { signal });
        const body = await response.json();
        return response.ok && body.code === 0 && Array.isArray(body.data?.items) && body.data.items.length > 0;
      }
      const body = await execute({ id: `probe:${provider}`, key: `probe:${provider}`, provider, routes: [] }, { action: 'list', query: '', offset: 0, limit: 1 }, signal);
      return Array.isArray(body.threads) && body.threads.length > 0;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  /** Every Agent provider that actually holds sessions becomes a tab; the list is no longer role-scoped. */
  async function probeAgents(current: AgentNode, signal?: AbortSignal): Promise<PersonaSessionAgent[]> {
    const deviceId = current.kind === 'peer' ? current.deviceId || '' : '';
    const known = remoteAgentProviders as readonly string[];
    const providers = [...new Set((options.candidates?.() ?? remoteAgentProviders).filter(provider => known.includes(provider)))];
    const available = await Promise.all(providers.map(provider => providerHasSessions(deviceId, provider, signal)));
    return providers.flatMap((provider, index): PersonaSessionAgent[] => available[index] ? [{
      id: `${current.kind}:${current.id}:${provider}`, provider, key: `${current.id}:${provider}`, routes: [],
      nodeId: current.id, nodeName: current.name, nodeKind: current.kind
    }] : []);
  }
  function instanceAgents(current: AgentNode): PersonaSessionAgent[] {
    const instanceId = current.instanceId || current.id;
    return (current.agents ?? []).filter(agent => agent.enabled !== false && bindableInstanceAgent(agent.agentId)).map(agent => {
      const provider = agent.provider === 'codex-desktop' ? 'codex' : agent.provider;
      return {
        id: `instance:${current.id}:${agent.agentId}`, key: `instance:${current.id}:${agent.agentId}`, provider,
        binding: { instanceId, agentId: agent.agentId },
        routes: [], label: agent.name || provider, nodeId: current.id, nodeName: current.name, nodeKind: 'instance'
      };
    });
  }
  return {
    async agents(_roleId: string, signal?: AbortSignal) {
      const current = node();
      if (current) return current.kind === 'instance' ? instanceAgents(current) : probeAgents(current, signal);
      const response = await request(peerManagerPath(sourceDeviceId, '/gateways?summary=1&includeConfig=1'), { signal });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.config?.gateways)) {
        throw new Error(body.message || '角色 Agent 端配置读取失败。');
      }
      return personaSessionAgents(body.data.config.gateways, _roleId);
    },
    async tasks(agent: PersonaSessionAgent, query: string, offset = 0, signal?: AbortSignal) {
      if (agent.nodeKind !== 'instance' && agent.provider === 'codex' && agentSessionMembersAvailable(agent)) {
        const queryString = new URLSearchParams({view:'roots',previews:'1',query,offset:String(offset),limit:'50'});
        const response = await request(targetPath(agent.binding?.ownerDeviceId, '/api/agent/providers/codex/sessions?'+queryString), {signal});
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
      const response = await request(targetPath(agent.binding?.ownerDeviceId, '/api/agent/providers/codex/sessions?'+query), {signal});
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(body.message || '子 Agent 列表读取失败。');
      return {items:body.data.items as PersonaAgentTask[],nextOffset:body.data.nextOffset as number|null ?? null};
    },
    history:readHistory,
    /** Local Manager first, then RabiLink computers and the Agent instances enrolled on those computers. */
    async nodes(signal?: AbortSignal): Promise<AgentNode[]> {
      const meta = await request('/meta', { signal }).then(response => response.json()).catch(() => undefined);
      const localName = typeof meta?.rabiName === 'string' && meta.rabiName.trim() ? meta.rabiName.trim() : '本机';
      const nodes: AgentNode[] = [{ id: 'local', kind: 'local', name: localName, online: true }];
      const response = await request('/api/rabilink/peer/servers', { signal });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.peers)) throw new Error(body.message || '远端节点列表读取失败。');
      const peers = (body.peers as Array<Record<string, unknown>>).flatMap(peer => {
        const deviceId = typeof peer.deviceId === 'string' ? peer.deviceId : '';
        if (!deviceId) return [];
        return [{ deviceId, online: peer.online === true, name: typeof peer.name === 'string' && peer.name ? peer.name : deviceId,
          latencyMs: typeof peer.latencyMs === 'number' ? peer.latencyMs : null }];
      });
      for (const peer of peers) {
        nodes.push({ id: `peer:${peer.deviceId}`, kind: 'peer', deviceId: peer.deviceId, online: peer.online,
          name: peer.name, latencyMs: peer.latencyMs });
      }
      const instanceTimeout = AbortSignal.timeout(8000);
      const instanceSignal = signal ? AbortSignal.any([signal, instanceTimeout]) : instanceTimeout;
      const instancePages = await Promise.allSettled(peers.filter(peer => peer.online).map(async peer => {
        const instanceResponse = await request(peerManagerPath(peer.deviceId, '/api/lan-agent/instances'), { signal: instanceSignal });
        const instanceBody = await instanceResponse.json();
        if (!instanceResponse.ok || instanceBody.code !== 0 || !Array.isArray(instanceBody.instances)) return [];
        return (instanceBody.instances as Array<Record<string, any>>).map(instance => ({ instance, peer }));
      }));
      for (const page of instancePages) {
        if (page.status !== 'fulfilled') continue;
        for (const { instance, peer } of page.value) {
          const instanceId = typeof instance.instanceId === 'string' ? instance.instanceId : '';
          if (!instanceId) continue;
          nodes.push({ id: `instance:${peer.deviceId}:${instanceId}`, kind: 'instance', instanceId, deviceId: peer.deviceId,
            online: peer.online && instance.connected !== false, name: instance.name || instance.hostname || instanceId,
            agents: Array.isArray(instance.agents) ? instance.agents.map((agent: Record<string, unknown>) => ({
              agentId: String(agent.agentId || ''), name: String(agent.name || agent.agentId || ''),
              provider: String(agent.provider || ''), enabled: agent.enabled !== false,
              routeId: typeof agent.routeId === 'string' ? agent.routeId : undefined
            })).filter((agent: { agentId: string; provider: string }) => agent.agentId && agent.provider && bindableInstanceAgent(agent.agentId)) : [] });
        }
      }
      return nodes;
    }
  };
}

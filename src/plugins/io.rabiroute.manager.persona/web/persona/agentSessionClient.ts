import { agentMessagePreview } from '@shared/agentSessionMessages';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor } from '../../../../../ribiwebgui/src/agentSessionHistory';
import type { GatewayDefinition } from '@shared/gatewayConfigModel';
import { normalizeRouteAgentTargets, type RouteAgentTarget } from '@shared/routeAgentTargets';
import { normalizeAgentInstanceBinding } from '@shared/agentInstance';
import { postRouteAgentThreadAction } from '../../../../../ribiwebgui/src/routeAgentThreadClient';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';

export type AgentNodeKind = 'local' | 'peer' | 'instance';
/** One selectable session source, taken from the shared computer directory. */
export type AgentNode = {
  id: string; kind: AgentNodeKind; name: string; online: boolean;
  /** Directory status keeps `unknown` distinguishable from a confirmed offline PC. */
  status?: string;
  platform?: string; deviceKind?: string;
  deviceId?: string; instanceId?: string; detail?: string; latencyMs?: number | null;
  agents?: ReadonlyArray<{ agentId: string; name: string; provider: string; enabled?: boolean; routeId?: string; workspace?: string }>;
};
export type PersonaSessionAgent = RouteAgentTarget & { key: string; dshBaseUrl?: string; routes: string[]; label?: string; nodeId?: string; nodeName?: string; nodeKind?: AgentNodeKind };
export type PersonaAgentTask = { id: string; title: string; cwd?: string; updatedAt?: string; archived?: boolean; parentThreadId?:string; agentNickname?:string; agentRole?:string; preview?:string; previewUnavailable?:boolean; lastMessageTime?:string; active?:boolean; status?:{type?:string} };

/** A session is running when the owner reports it active; Codex leaves both fields empty. */
export function agentSessionRunning(task: PersonaAgentTask): boolean {
  return task.active === true || task.status?.type === 'active';
}

export function agentSessionMembersAvailable(agent:PersonaSessionAgent|undefined):boolean {
  return Boolean(agent?.provider === 'codex' && !agent.binding && (!agent.nodeKind || agent.nodeKind !== 'instance'));
}

/** Remote nodes keep the same session layout, so only genuinely executable providers become tabs. */
export const remoteAgentProviders = ['codex', 'dsh', 'grokBot', 'workbuddy', 'antigravity', 'copilotCli'] as const;
/**
 * Antigravity now answers threads.list from its own conversation index and threads.history
 * from its JSONL transcript, so it browses like the others. Copilot CLI still has no thread
 * operations at all and stays out.
 */
export const historyCapableProviders = ['codex', 'dsh', 'grokBot', 'workbuddy', 'antigravity'] as const;
/** One page covers a node's first screen; older sessions stay available through continuation. */
export const SESSION_PAGE_SIZE = 30;
/** A probe that cannot answer quickly is not worth blocking a node's first paint. */
export const PROBE_TIMEOUT_MS = 4000;
/** Adapters that answer by calling a remote vendor are slower than a local file read, but a
 * provider stuck in its own retry loop must still not hold the list open. */
export const PROBE_TIMEOUT_REMOTE_MS = 4000;

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
  /** A local instance binding reaches the same thread operation this Manager already serves. */
  async function postLocalThread(payload: Record<string, unknown>, signal?: AbortSignal) {
    const response = await request('/api/agent/threads', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok || body.code === -1) throw new Error(body.message || 'Agent 会话操作失败。');
    return body as Record<string, any>;
  }
  const execute = (agent: PersonaSessionAgent, payload: Record<string, unknown>, signal?: AbortSignal) => {
    const remote = Boolean(peerDevice());
    // An independent node posts to this Manager; a relay host's instance posts on that computer.
    if (agent.nodeKind === 'instance' && agent.binding) {
      const instanceBinding = { instanceId: agent.binding.instanceId, agentId: agent.binding.agentId };
      if (remote) return postPeerThread(peerDevice(), { ...payload, agentAdapter: agent.provider, instanceBinding }, signal);
      return postLocalThread({ ...payload, agentAdapter: agent.provider, instanceBinding }, signal);
    }
    return postRouteAgentThreadAction(
      { ...payload, ...((!remote && agent.dshBaseUrl) ? { dshBaseUrl: agent.dshBaseUrl } : {}) },
      agent,
      { fetch: remote ? peerFetch : request, accessToken: () => '', signal }
    );
  };
  const previewCache = new Map<string,{preview:string;lastMessageTime?:string}>();
  async function readHistory(agent: PersonaSessionAgent, taskId: string, cursor?: string, signal?: AbortSignal) {

      // Native provider history applies to an unbound endpoint; a bound instance keeps its instance operation.
      const nativeProvider = !agent.binding && (agent.provider === 'codex' || agent.provider === 'dsh' && !agent.dshBaseUrl);
      if (nativeProvider) {
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
      // A probe answers "is there a first row"; previews would make it scan every transcript.
      const probeDeadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const probe = signal ? AbortSignal.any([signal, probeDeadline]) : probeDeadline;      if (provider === 'codex' || provider === 'dsh') {
        const query = provider === 'codex'
          ? new URLSearchParams({ view: 'roots', offset: '0', limit: '1' })
          : new URLSearchParams({ offset: '0', limit: '1' });
        const response = await request(providerPath(deviceId, `/api/agent/providers/${provider}/sessions?${query}`), { signal: probe });
        const body = await response.json();
        return response.ok && body.code === 0 && Array.isArray(body.data?.items) && body.data.items.length > 0;
      }
      const body = await execute({ id: `probe:${provider}`, key: `probe:${provider}`, provider, routes: [] }, { action: 'list', query: '', offset: 0, limit: 1 }, probe);
      return Array.isArray(body.threads) && body.threads.length > 0;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  /**
   * Every known provider is yielded at once. A provider with no sessions simply returns an
   * empty page, so the probe round is unnecessary: the first page read doubles as the probe
   * and the first paint, and one slow adapter never delays the others.
   */
  function agentForProvider(current: AgentNode, provider: string): PersonaSessionAgent {
    return { id: `${current.kind}:${current.id}:${provider}`, provider, key: `${current.id}:${provider}`, routes: [],
      nodeId: current.id, nodeName: current.name, nodeKind: current.kind };
  }
  function providerCandidates(current: AgentNode): string[] {
    const known = historyCapableProviders as readonly string[];
    return [...new Set((options.candidates?.() ?? historyCapableProviders).filter(provider => known.includes(provider)))];
  }
  /** A blocking list of providers, for callers that need the whole set before rendering. */
  async function probeAgents(current: AgentNode, signal?: AbortSignal): Promise<PersonaSessionAgent[]> {
    const deviceId = current.kind === 'peer' ? current.deviceId || '' : '';
    const providers = providerCandidates(current);
    const available: string[] = [];
    await Promise.all(providers.map(async provider => {
      if (await providerHasSessions(deviceId, provider, signal)) available.push(provider);
    }));
    return providers.filter(provider => available.includes(provider)).map(provider => agentForProvider(current, provider));
  }
  function instanceAgents(current: AgentNode): PersonaSessionAgent[] {
    const instanceId = current.instanceId || current.id;
    return (current.agents ?? []).filter(agent => agent.enabled !== false && bindableInstanceAgent(agent.agentId)).map(agent => {
      const provider = agent.provider === 'codex-desktop' ? 'codex' : agent.provider;
      return {
        id: `instance:${current.id}:${agent.agentId}`, key: `instance:${current.id}:${agent.agentId}`, provider,
        // A relay host resolves the instance on its own computer; an independent node resolves it here.
        binding: { instanceId, agentId: agent.agentId, ...(current.deviceId ? { ownerDeviceId: current.deviceId } : {}) },
        routes: [], label: agent.name || provider, nodeId: current.id, nodeName: current.name, nodeKind: 'instance'
      };
    });
  }
  return {
    /**
     * Yields each Agent endpoint as soon as it is known. A directory entry lists its endpoints,
     * so those arrive immediately; a probed computer streams them in probe-completion order.
     */
    async *agentsStream(_roleId: string, signal?: AbortSignal): AsyncGenerator<PersonaSessionAgent> {
      const current = node();
      if (!current) { for (const agent of await this.agents(_roleId, signal)) yield agent; return; }
      if (current.status === 'offline') return;
      if (current.kind === 'instance') { for (const agent of instanceAgents(current)) yield agent; return; }
      const listed = (current.agents ?? []).filter(agent => agent.enabled !== false && (current.deviceId || bindableInstanceAgent(agent.agentId)));
      if (listed.length) {
        for (const agent of listed) yield {
          id: `${current.kind}:${current.id}:${agent.agentId}`, key: `${current.kind}:${current.id}:${agent.agentId}`,
          provider: agent.provider === 'codex-desktop' ? 'codex' : agent.provider,
          binding: current.deviceId ? undefined : { instanceId: current.instanceId || current.id, agentId: agent.agentId },
          routes: [], label: agent.name, nodeId: current.id, nodeName: current.name, nodeKind: current.kind
        };
        return;
      }
      // No probe round: every provider is offered at once, and the caller's first page read is
      // both the probe and the first paint. An adapter with nothing returns an empty page.
      for (const provider of providerCandidates(current)) yield agentForProvider(current, provider);
    },
    async agents(_roleId: string, signal?: AbortSignal) {
      const current = node();
      if (!current) {
        const response = await request(peerManagerPath(sourceDeviceId, '/gateways?summary=1&includeConfig=1'), { signal });
        const body = await response.json();
        if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.config?.gateways)) {
          throw new Error(body.message || '角色 Agent 端配置读取失败。');
        }
        return personaSessionAgents(body.data.config.gateways, _roleId);
      }
      // A directory entry already names its Agent endpoints, so it is trusted before probing.
      // An offline computer keeps its row but reports no readable endpoints.
      if (current.status === 'offline') return [];
      if (current.kind === 'instance') return instanceAgents(current);
      const listed = (current.agents ?? []).filter(agent => agent.enabled !== false && (current.deviceId || bindableInstanceAgent(agent.agentId)));
      if (listed.length) {
        return listed.map(agent => ({
          id: `${current.kind}:${current.id}:${agent.agentId}`, key: `${current.kind}:${current.id}:${agent.agentId}`,
          provider: agent.provider === 'codex-desktop' ? 'codex' : agent.provider,
          binding: current.deviceId ? undefined : { instanceId: current.instanceId || current.id, agentId: agent.agentId },
          routes: [], label: agent.name, nodeId: current.id, nodeName: current.name, nodeKind: current.kind
        }));
      }
      return probeAgents(current, signal);
    },
    async tasks(agent: PersonaSessionAgent, query: string, offset = 0, signal?: AbortSignal) {
      // Only a native provider with a known owner reads the provider history; everything else is a binding.
      if (!agent.binding && agent.provider === 'codex' && agentSessionMembersAvailable(agent)) {
        // `previews=1` makes the owner scan every transcript on each page; the compact list shows
        // only a title and a time, so the listing is read without previews.
        const queryString = new URLSearchParams({view:'roots',query,offset:String(offset),limit:String(SESSION_PAGE_SIZE)});
        const response = await request(targetPath(undefined, '/api/agent/providers/codex/sessions?'+queryString), {signal});
        const body = await response.json();
        if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(body.message || 'Agent 端未返回会话列表。');
        return {items:body.data.items as PersonaAgentTask[],nextOffset:body.data.nextOffset as number|null ?? null};
      }
      const body = await execute(agent, { action: 'list', query, offset, limit: SESSION_PAGE_SIZE }, signal);
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
    /**
     * The computer directory is the single source of devices, so this list matches the
     * Device control page: hosts, LAN nodes and phones share its identity, status and platform.
     */
    async nodes(signal?: AbortSignal): Promise<AgentNode[]> {
      const response = await request('/api/computers', { signal });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.computers)) {
        throw new Error(body.message || '电脑目录读取失败。');
      }
      return (body.data.computers as Array<Record<string, any>>).flatMap((computer): AgentNode[] => {
        const kind = computer.kind === 'host' ? 'host' : 'node';
        const instanceId = typeof computer.instanceId === 'string' ? computer.instanceId : '';
        const ownerDeviceId = typeof computer.ownerDeviceId === 'string' ? computer.ownerDeviceId : '';
        const local = computer.local === true;
        const id = local ? 'local' : kind === 'host' && ownerDeviceId ? `peer:${ownerDeviceId}` : `node:${instanceId}`;
        if (!local && !ownerDeviceId && !instanceId) return [];
        const agents = (Array.isArray(computer.agents) ? computer.agents : []).flatMap((agent: Record<string, unknown>) => {
          const agentId = typeof agent.agentId === 'string' ? agent.agentId : '';
          const agentKind = typeof agent.provider === 'string' ? agent.provider : '';
          if (!agentId || !agentKind) return [];
          // A node's own Agent is an instance binding; a relay host reads its providers natively.
          const bindable = kind === 'node' ? bindableInstanceAgent(agentId) : true;
          return bindable ? [{ agentId, name: typeof agent.name === 'string' ? agent.name : agentId,
            provider: agentKind, enabled: agent.enabled !== false }] : [];
        });
        return [{
          id, kind: local ? 'local' : kind === 'host' ? 'peer' : 'instance',
          name: String(computer.name || computer.hostname || instanceId || ownerDeviceId),
          platform: typeof computer.platform === 'string' ? computer.platform : undefined,
          deviceKind: typeof computer.deviceKind === 'string' ? computer.deviceKind : undefined,
          status: typeof computer.status === 'string' ? computer.status : 'unknown',
          online: local || computer.status === 'online',
          instanceId: instanceId || undefined,
          deviceId: ownerDeviceId || undefined,
          agents
        }];
      });
    }
  };
}

import type { AgentThreadRequest, AgentThreadRequestOptions, AgentThreadRequestResult } from '../agentThreads.js';
import type { createDeviceAgentOwner } from '../agentAdapters/deviceAgentOwner.js';

type DeviceOwner = ReturnType<typeof createDeviceAgentOwner>;
export type DeviceAgentThreadsOptions = {
  ownerInstanceId: string;
  scope(): string;
  owner: Pick<DeviceOwner, 'sessions' | 'readSession'>;
};
const failure = (code: string, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

/** Only the registered device session is addressable here. No PC-side model or session creation. */
export async function handleDeviceAgentThreadRequest(request: AgentThreadRequest, admission: Pick<AgentThreadRequestOptions, 'remoteSource'> & { requestAuthority?: () => void }, options: DeviceAgentThreadsOptions): Promise<AgentThreadRequestResult | undefined> {
  admission.requestAuthority?.();
  // All sends and formal replies use the shared AgentRequest endpoint ledger, including device targets.
  if(request.action==='send' || request.action==='reconcile_delivery') return undefined;
  if (request.agentAdapter && request.agentAdapter !== 'deviceAgent') return undefined;
  if (!request.agentAdapter && !request.threadId && !request.instanceBinding) return undefined;
  if (!request.agentAdapter && request.instanceBinding && request.instanceBinding.instanceId !== options.ownerInstanceId) return undefined;
  const scope = options.scope();
  const sessions = scope ? options.owner.sessions(scope) : [];
  const binding = request.instanceBinding;
  const selected = binding?.instanceId === options.ownerInstanceId
    ? sessions.find(row => row.agentId === binding.agentId)
    : !binding && request.threadId ? sessions.find(row => row.sessionId === request.threadId) : undefined;
  if (request.agentAdapter !== 'deviceAgent' && !selected) return undefined;
  if (request.agentAdapter && request.agentAdapter !== 'deviceAgent') throw failure('DEVICE_AGENT_PROVIDER_MISMATCH');
  if (!scope) throw failure('DEVICE_AGENT_CONNECTION_REQUIRED', 503);
  if (request.agentTargetId) throw failure('DEVICE_AGENT_INSTANCE_BINDING_REQUIRED');
  if (binding && binding.instanceId !== options.ownerInstanceId) throw failure('DEVICE_AGENT_REMOTE_OWNER_REQUIRED', 503);
  const assertAuthority = async () => {
    admission.requestAuthority?.();
    if (options.scope() !== scope) throw failure('DEVICE_AGENT_CONNECTION_CHANGED', 401);
  };
  await assertAuthority();
  const action = request.action || 'list';
  if (action === 'list') {
    if (binding && !selected) throw failure('DEVICE_AGENT_SESSION_NOT_FOUND', 404);
    const limit = request.limit ?? 100, offset = request.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw failure('DEVICE_AGENT_PAGE_INVALID');
    const query = (request.query || '').trim().toLowerCase();
    const rows = sessions.filter(row => (!binding || row.agentId === binding.agentId) && (!query || row.name.toLowerCase().includes(query) || row.sessionId.toLowerCase().includes(query)));
    return { statusCode: 200, data: { code: 0, agentAdapter: 'deviceAgent', total: rows.length, threads: rows.slice(offset, offset + limit).map(row => ({ id: row.sessionId, title: row.name, updatedAt: row.updatedAt, loaded: row.loaded, instanceBinding: { instanceId: options.ownerInstanceId, agentId: row.agentId } })) } };
  }
  if (!selected || !request.threadId || selected.sessionId !== request.threadId) throw failure('DEVICE_AGENT_SESSION_NOT_FOUND', 404);
  if (action === 'read') return { statusCode: 200, data: { code: 0, agentAdapter: 'deviceAgent', thread: options.owner.readSession(scope, selected.agentId, request.threadId) } };
  throw failure('DEVICE_AGENT_ACTION_UNSUPPORTED', 422);
}

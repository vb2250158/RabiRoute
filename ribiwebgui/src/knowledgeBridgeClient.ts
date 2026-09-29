export type KnowledgeGrant = { appId: string; deviceBindingId: string; ownerAccountId: string };
export type KnowledgeBridgeDraft = { enabled: boolean; url: string; token: string; roles: string; tools: string; allowWrites: boolean; grants: string };
export const knowledgeToolNames = ['knowledge_search','plan_list','plan_get','plan_statuses','memory_list','memory_get','plan_create','plan_update','recent_memory_create','recent_memory_update'];
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
export function knowledgeBridgeDraft(value: unknown): KnowledgeBridgeDraft {
  const v = object(value);
  return { enabled: v.enabled === true, url: typeof v.url === 'string' ? v.url : '', token: '', roles: Array.isArray(v.allowedRoles) ? v.allowedRoles.join('\n') : '', tools: Array.isArray(v.allowedTools) ? v.allowedTools.join('\n') : '', allowWrites: v.allowWrites === true, grants: JSON.stringify(Array.isArray(v.grants) ? v.grants : [], null, 2) };
}
export function knowledgeBridgePatch(draft: KnowledgeBridgeDraft, tokenConfigured: boolean) {
  const ids = (text: string) => {
    const items = text.split(/[\s,]+/).filter(Boolean);
    if (items.length > 256 || new Set(items).size !== items.length || items.some(s => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s))) throw new Error('角色或工具标识格式无效');
    return items;
  };
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(draft.url) || Number(new URL(draft.url).port || 80) > 65535) throw new Error('仅允许本机 http://127.0.0.1:端口/mcp');
  const roles = ids(draft.roles), tools = ids(draft.tools);
  if (tools.some(name => !knowledgeToolNames.includes(name))) throw new Error('工具不在支持清单中');
  const grants: unknown = JSON.parse(draft.grants);
  if (!Array.isArray(grants) || grants.length > 256) throw new Error('设备授权必须是有限的 JSON 数组');
  const normalized = grants.map(raw => {
    const g = object(raw);
    if (Object.keys(g).length !== 3 || Object.keys(g).some(k => !['appId','deviceBindingId','ownerAccountId'].includes(k))) throw new Error('设备授权仅允许三个归属标识');
    for (const key of ['appId','deviceBindingId','ownerAccountId']) if (typeof g[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(g[key] as string)) throw new Error('设备授权标识无效');
    return { appId: g.appId, deviceBindingId: g.deviceBindingId, ownerAccountId: g.ownerAccountId };
  });
  if (new Set(normalized.map(g => JSON.stringify(g))).size !== normalized.length) throw new Error('设备授权重复');
  if (draft.enabled && (!roles.length || !tools.length || !normalized.length)) throw new Error('启用前必须设置角色、工具与设备授权');
  if (draft.token && (!/^[\x21-\x7e]{32,4096}$/.test(draft.token) || /^\*+$/.test(draft.token))) throw new Error('密钥必须为至少32字符，不接受掩码');
  if (!draft.token && !tokenConfigured) throw new Error('首次配置需输入密钥');
  return { rabiLinkRelay: { knowledgeBridge: { enabled: draft.enabled, url: draft.url, allowedRoles: roles, allowedTools: tools, allowWrites: draft.allowWrites, grants: normalized, ...(draft.token ? { token: draft.token } : {}) } } };
}
export async function readKnowledgeIdentity(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/rabi/identity', { credentials: 'same-origin', cache: 'no-store' });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.data) throw new Error('读取本机知识桥配置失败');
  const bridge = object(object(body.data.rabiLinkRelay).knowledgeBridge);
  // Never propagate a secret even if a server mistakenly returns one.
  const { token: _secret, ...safe } = bridge;
  return { bridge: safe, tokenConfigured: bridge.tokenConfigured === true };
}
export async function saveKnowledgeIdentity(patch: ReturnType<typeof knowledgeBridgePatch>, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/rabi/identity', { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.data) throw new Error('保存未确认，请刷新核对，不要自动重试');
  const snapshot = await readKnowledgeIdentity(fetcher);
  const expected = knowledgeBridgeDraft(patch.rabiLinkRelay.knowledgeBridge);
  const actual = knowledgeBridgeDraft(snapshot.bridge);
  if (JSON.stringify(actual) !== JSON.stringify(expected) || !snapshot.tokenConfigured) throw new Error('保存后读取不一致，请核对并发修改；禁止自动重试');
  return snapshot;
}

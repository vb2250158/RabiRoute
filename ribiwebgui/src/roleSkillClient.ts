export interface RoleSkill {
  id: string; title: string; summary: string; status: string; updatedAt: string; keywords: string[]; content?: string;
}
export interface RoleSkillState {
  roleId: string; items: RoleSkill[]; detail: RoleSkill | null;
  loading: boolean; detailLoading: boolean; error: boolean; detailError: boolean;
}
export function roleSkillPath(roleId: string, skillId?: string): string {
  if (!roleId.trim() || (skillId !== undefined && !skillId.trim())) throw new Error('Missing skill identity');
  return `/api/roles/${encodeURIComponent(roleId)}/skills${skillId === undefined ? '' : `/${encodeURIComponent(skillId)}`}`;
}
function parseItem(value: unknown, detail = false): RoleSkill {
  const item = value as RoleSkill;
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || typeof item.summary !== 'string'
    || typeof item.status !== 'string' || typeof item.updatedAt !== 'string' || !Array.isArray(item.keywords)
    || !item.keywords.every(word => typeof word === 'string') || (detail && typeof item.content !== 'string')) throw new Error('Invalid skill response');
  return { id: item.id, title: item.title, summary: item.summary, status: item.status, updatedAt: item.updatedAt, keywords: [...item.keywords], ...(detail ? { content: item.content } : {}) };
}
/** Transient UI projection only. fetch uses the application's installed Manager prefix/auth adapter. */
export function createRoleSkillBrowser(state: RoleSkillState, request: typeof fetch = fetch) {
  let epoch = 0, detailEpoch = 0;
  let listAbort: AbortController | undefined, detailAbort: AbortController | undefined;
  function cancel() { epoch++; detailEpoch++; listAbort?.abort(); detailAbort?.abort(); }
  async function get(path: string, signal: AbortSignal) {
    const response = await request(path, { signal });
    if (!response.ok) throw new Error('Skill request failed');
    const result = await response.json();
    if (result?.code !== 0) throw new Error('Skill request failed');
    return result.data;
  }
  async function load(roleId: string) {
    cancel();
    Object.assign(state, { roleId, items: [], detail: null, loading: !!roleId, detailLoading: false, error: false, detailError: false });
    if (!roleId) return;
    const current = epoch;
    listAbort = new AbortController();
    try {
      const data = await get(roleSkillPath(roleId), listAbort.signal);
      if (!Array.isArray(data)) throw new Error('Invalid skill list');
      const items = data.map(item => parseItem(item));
      if (current === epoch) state.items = items;
    } catch { if (current === epoch) state.error = true; }
    finally { if (current === epoch) state.loading = false; }
  }
  async function select(id: string) {
    detailAbort?.abort();
    const current = ++detailEpoch, roleEpoch = epoch;
    state.detail = null; state.detailError = false; state.detailLoading = true;
    detailAbort = new AbortController();
    try {
      const item = parseItem(await get(roleSkillPath(state.roleId, id), detailAbort.signal), true);
      if (item.id !== id) throw new Error('Skill identity mismatch');
      if (current === detailEpoch && roleEpoch === epoch) state.detail = item;
    } catch { if (current === detailEpoch && roleEpoch === epoch) state.detailError = true; }
    finally { if (current === detailEpoch && roleEpoch === epoch) state.detailLoading = false; }
  }
  return { load, select, dispose: cancel };
}

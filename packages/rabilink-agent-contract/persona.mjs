import { validateAgentProfile, PROFILE_LIMITS } from './profile.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const roleKey = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail('PERSONA_ID_INVALID'); return value; };
// Manager readers may return the public JSON envelope or its data exactly once.
const unwrap = value => value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
export async function readAiuiPersonaTemplate({ read, roleId, sourceDeviceId, skillIds = [] }) {
  roleKey(roleId);
  if (!Array.isArray(skillIds) || skillIds.length > PROFILE_LIMITS.skills || new Set(skillIds).size !== skillIds.length) fail('PERSONA_SKILL_SELECTION_INVALID');
  skillIds.forEach(roleKey);
  const before = unwrap(await read('/meta'));
  if (!before.applicationGenerationId || !before.managerInstanceId || !before.health?.live || !before.health?.requiredReady) fail('PERSONA_SOURCE_NOT_READY');
  const list = unwrap(await read('/api/personas'));
  const persona = list.personas?.find(item => item.personaId === roleId);
  if (!persona) fail('PERSONA_NOT_FOUND');
  const base = '/api/roles/' + encodeURIComponent(roleId);
  const reference = unwrap(await read(base + '/persona-reference?file=persona.md'));
  const document = reference?.document;
  if (typeof document !== 'string' || reference.roleId !== roleId) fail('PERSONA_REFERENCE_INVALID');
  const skills = [];
  for (const skillId of skillIds) {
    const reply = await read(base + '/skills/' + encodeURIComponent(skillId));
    const source = unwrap(reply);
    const content = source?.content ?? source?.skill?.content;
    if (typeof content !== 'string') fail('PERSONA_SKILL_INVALID');
    skills.push({ id: skillId, title: source?.title || source?.name || source?.skill?.title || skillId, content, enabled: true });
  }
  const after = unwrap(await read('/meta'));
  if (before.applicationGenerationId !== after.applicationGenerationId || before.managerInstanceId !== after.managerInstanceId) fail('PERSONA_SOURCE_CHANGED');
  return validateAgentProfile({ revision: 1, id: roleId, name: persona.name || roleId, systemPrompt: document, skills,
    mcp: [], personaRef: { roleId, sourceDeviceId } });
}

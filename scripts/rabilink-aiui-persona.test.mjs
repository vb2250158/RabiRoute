import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readAiuiPersonaTemplate } from '../packages/rabilink-agent-contract/persona.mjs';
import { validateAgentProfile } from '../packages/rabilink-agent-contract/profile.mjs';
import { validateAgentProfile as validateClient, buildAgentSystemInstructions } from '../apps/rabilink-aiui/utils/agent-profile.js';
const meta = { applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, requiredReady: true } };
test('real HTTP Manager envelopes and once-unwrapped callbacks produce identical persona templates', async t => {
  const server = http.createServer((req, res) => {
    const data = req.url === '/meta' ? meta : req.url === '/api/personas' ? { personas: [{ personaId: 'Example', name: 'Example' }] }
      : req.url.includes('/persona-reference') ? { roleId: 'Example', document: 'Persona text' } : { skill: { content: 'Skill text', title: 'Skill' } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/meta' ? data : { code: 0, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const read = async path => (await fetch(base + path)).json();
  const args = { roleId: 'Example', sourceDeviceId: 'source-pc', skillIds: ['skill'] };
  const wire = await readAiuiPersonaTemplate({ ...args, read });
  const unwrapped = await readAiuiPersonaTemplate({ ...args, read: async path => { const reply = await read(path); return reply.data ?? reply; } });
  assert.deepEqual(wire, unwrapped);
  assert.equal(wire.systemPrompt, 'Persona text'); assert.equal(wire.skills[0].content, 'Skill text');
});
test('persona binding adopts official persona and chosen Skills from its source PC with consistent wire schemas', async () => {
  const read = async path => path === '/meta' ? meta : path === '/api/personas' ? { personas: [{ personaId: 'Example', name: '示例人格' }] }
    : path.includes('/persona-reference') ? { data: { roleId: 'Example', document: '# 示例人格\n人格指引' } } : { data: { content: '技能正文', title: '技能' } };
  const profile = await readAiuiPersonaTemplate({ read, roleId: 'Example', sourceDeviceId: 'source-pc', skillIds: ['skill'] });
  assert.deepEqual(profile.personaRef, { roleId: 'Example', sourceDeviceId: 'source-pc' });
  assert.equal(profile.skills[0].content, '技能正文');
  assert.deepEqual(validateAgentProfile(profile), validateClient(profile));
  assert.match(buildAgentSystemInstructions(profile), /不限制接口或其他人格操作/);
});
test('unbound profiles stay valid and binding has no executable/authentication configuration', () => {
  const profile = { revision: 1, id: 'assistant', name: '助手', systemPrompt: '', skills: [], mcp: [], personaRef: null };
  assert.equal(validateClient(profile).personaRef, null);
  assert.throws(() => validateAgentProfile({ ...profile, personaRef: { roleId: 'Example', sourceDeviceId: 'pc', allowedRoles: ['Example'] } }));
});
test('generation change and missing persona reject adoption; neither creates a replacement persona', async () => {
  let metas = 0;
  const read = async path => path === '/meta' ? { ...meta, applicationGenerationId: metas++ ? 'other' : 'generation' } : path === '/api/personas' ? { personas: [{ personaId: 'Example' }] } : { data: { roleId: 'Example', document: '指引' } };
  await assert.rejects(readAiuiPersonaTemplate({ read, roleId: 'Example', sourceDeviceId: 'pc' }), /SOURCE_CHANGED/);
  await assert.rejects(readAiuiPersonaTemplate({ read: async path => path === '/meta' ? meta : { personas: [] }, roleId: 'Missing', sourceDeviceId: 'pc' }), /NOT_FOUND/);
});

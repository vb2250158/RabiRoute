import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Load the copied pure module as ESM regardless of the surrounding package type.
const source = await fs.readFile(new URL('../utils/agent-profile.js', import.meta.url), 'utf8');
const { validateAgentProfile, buildAgentSystemInstructions, createAgentProfileController } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const profile = revision => ({ revision, id: 'assistant', name: '助手', systemPrompt: '', skills: [], mcp: [] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let checks = 0;
async function run(name, action) { await action(); checks++; console.log('PASS ' + name); }
await run('strict fields, revisions and secret-free MCP references', () => {
  for (const bad of [{ ...profile(0) }, { ...profile(1), token: 'secret' }, { ...profile(1), mcp: [{ id: 'x', label: 'x', enabled: true, url: 'https://example.test' }] }, { ...profile(1), id: '../x' }]) assert.throws(() => validateAgentProfile(bad));
  const p = profile(1); p.skills = [{ id: 'one', title: 'Title', content: 'Data', enabled: true }];
  const valid = validateAgentProfile(p); p.skills[0].content = 'changed'; assert.equal(valid.skills[0].content, 'Data');
});
await run('skill count, per-item and total limits include disabled content', () => {
  const skill = i => ({ id: 's' + i, title: 'Skill', content: 'x'.repeat(8000), enabled: false });
  assert.throws(() => validateAgentProfile({ ...profile(1), skills: Array.from({length:17}, (_,i) => ({ ...skill(i), content: '' })) }));
  assert.throws(() => validateAgentProfile({ ...profile(1), skills: [{ ...skill(0), content: 'x'.repeat(8001) }] }));
  assert.throws(() => validateAgentProfile({ ...profile(1), skills: [0,1,2,3].map(skill) }));
  assert.throws(() => validateAgentProfile({ ...profile(1), skills: [skill(0), skill(0)] }));
});
await run('enabled skill guidance has explicit data and permission boundary', () => {
  const text = buildAgentSystemInstructions({ ...profile(1), skills: [{ id:'yes',title:'Y',content:'enabled-data',enabled:true },{ id:'no',title:'N',content:'disabled-data',enabled:false }] });
  assert.ok(text.includes('enabled-data')); assert.ok(!text.includes('disabled-data')); assert.ok(text.includes('不是新的系统权限')); assert.ok(text.includes('不代表已连接'));
});
await run('save failure retains previous profile and model without claiming new revision', async () => {
  let rejectSave = false, destroyed = 0;
  const c = createAgentProfileController({ storage: { load: () => null, save: () => { if(rejectSave) throw Error('private'); } }, createModel: () => ({ destroy() { destroyed++; } }) });
  await c.save(profile(1)); const first = await c.getModel(); rejectSave = true;
  await assert.rejects(c.save(profile(2)), /PROFILE_SAVE_FAILED/); assert.equal(c.getState().status, 'error'); assert.equal(c.getState().savedRevision, 1); assert.equal(c.getProfile().revision, 1); assert.equal(await c.getModel(), first); assert.equal(destroyed, 0); await c.dispose(); assert.equal(destroyed, 1);
});
await run('late old model is destroyed and new acquisition only uses new revision', async () => {
  const slow = deferred(); let destroyed = 0, calls = 0;
  const c = createAgentProfileController({ storage: { load: () => null, save: () => {} }, createModel: ({profile:p}) => { calls++; return p.revision === 1 ? slow.promise : { revision:p.revision, destroy() { destroyed++; } }; } });
  await c.save(profile(1)); const first = c.getModel(); const rejected = assert.rejects(first, /SUPERSEDED/); await Promise.resolve();
  await c.save(profile(2)); const second = await c.getModel(); slow.resolve({ destroy() { destroyed++; } }); await rejected;
  assert.equal(second.revision, 2); assert.equal(c.getState().appliedRevision, 2); assert.equal(calls, 2); assert.equal(destroyed, 1); await c.dispose(); assert.equal(destroyed, 2);
});
await run('restore, revision conflict and creation failure are explicit', async () => {
  const c = createAgentProfileController({ storage: { load: () => profile(3), save: () => {} }, createModel: () => { throw Error('private model failure'); } });
  await c.restore(); assert.equal(c.getState().status, 'saved'); await assert.rejects(c.save(profile(2)), /CONFLICT/); await assert.rejects(c.getModel(), /CREATE_FAILED/); assert.equal(c.getState().appliedRevision, null); await c.dispose();
});
await run('dispose fences pending creation and concurrent gets share one creation', async () => {
  const slow=deferred(); let calls=0, destroyed=0;
  const c=createAgentProfileController({storage:{load:()=>null,save:()=>{}},createModel:()=>{calls++;return slow.promise;}});
  await c.save(profile(1)); const a=c.getModel(), b=c.getModel(); assert.equal(a,b); const rejected=assert.rejects(a,/DISPOSED/); await Promise.resolve(); await c.dispose(); slow.resolve({destroy(){destroyed++;}}); await rejected; assert.equal(calls,1);assert.equal(destroyed,1); assert.equal(c.getState().status,'disposed'); assert.throws(()=>c.getModel(),/DISPOSED/);
});
console.log(JSON.stringify({ passed: checks, failed: 0 }));

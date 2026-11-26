import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor, latestAgentConversationPage } from '../src/agentSessionHistory';
import { createAgentSessionClient, personaSessionAgents, agentSessionProject, agentSessionMembersAvailable } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient';
import type { GatewayDefinition } from '../../src/shared/gatewayConfigModel';
import { remoteAgentTargetKey } from '../../src/shared/routeAgentTargets';

const native = (sequence: number, type: string, payload: Record<string, unknown>) => ({ sequence, record: { type, payload } });
const dsh = (seq: number, type: string, data: Record<string, unknown>) => ({ type: 'event', event: { seq, type, data } });

test('only complete Codex instruction envelopes are shown as injected prompts', () => {
  const heading = '# AGENTS.md instructions for C:\\Projects\\Example';
  const envelope = `${heading}\r\n\r\n<INSTRUCTIONS>\r\n# Project setup\r\n</INSTRUCTIONS>\r\n<environment_context>\r\n  <cwd>C:\\Projects\\Example</cwd>\r\n</environment_context>`;
  const entries = [envelope, `${envelope}\nCan you summarize this?`, `${heading}\nA pasted heading.`]
    .map((message, index) => native(index + 1, 'event_msg', { type: 'user_message', message }));
  const messages = agentHistoryMessages('codex', agentHistoryEvents('codex', { entries }));
  assert.equal(messages[0]?.instructionHeading, heading);
  assert.equal(messages[0]?.text, envelope);
  assert.equal(messages[1]?.instructionHeading, undefined);
  assert.equal(messages[2]?.instructionHeading, undefined);
});

test('configured Agents switch through second-level tabs bound to the selected endpoint', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  assert.match(source, /<v-tabs v-model="agentKey"[^>]*:aria-label="t\('Agent 端'\)"/);
  assert.match(source, /<v-tab v-for="item in agents"[^>]*:value="item.key"/);
  assert.doesNotMatch(source, /<v-select\b/);
});

test('Codex history shows user input and final replies, filters tools/reasoning/commentary, deduplicates native streams across pages', () => {
  const first = agentHistoryEvents('codex', { entries: [
    native(1, 'event_msg', { type: 'user_message', message: 'Question' }),
    null,
    native(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] }),
    native(3, 'response_item', { type: 'reasoning', summary: [{ text: 'private reasoning' }] }),
    native(4, 'response_item', { type: 'function_call', arguments: 'private tool input' }),
    native(5, 'response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] }),
    native(6, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Answer' }] })
  ] });
  const second = agentHistoryEvents('codex', { entries: [
    native(7, 'event_msg', { type: 'task_complete', last_agent_message: 'Answer' }),
    native(8, 'event_msg', { type: 'user_message', message: 'Question' }),
    native(9, 'event_msg', { type: 'user_message', message: 'Question' })
  ] });
  assert.deepEqual(agentHistoryMessages('codex', [...first, ...second]).map(item => [item.role, item.text]), [
    ['user', 'Question'], ['assistant', 'Answer'], ['user', 'Question'], ['user', 'Question']
  ]);
  assert.equal(agentHistoryNextCursor('codex', { nextCursor: 'native-cursor', entries: [] }), 'native-cursor');
});

test('DSH history chooses the last assistant message of completed turns and keeps backwards page boundaries', () => {
  const newer = { hasMore: true, cursor: 99, records: [
    dsh(5, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Final reply' }, { type: 'reasoning', text: 'hidden' }] } }),
    dsh(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    dsh(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'In progress' }] } })
  ] };
  const older = { records: [
    dsh(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }),
    dsh(2, 'user/message', { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Injected context' }] }),
    dsh(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Intermediate text' }] } }),
    dsh(4, 'tool/result', { text: 'hidden tool result' })
  ] };
  assert.equal(agentHistoryNextCursor('dsh', newer), '5', 'beforeSeq uses first returned event, not the throughSeq watermark');
  assert.deepEqual(agentHistoryMessages('dsh', [...agentHistoryEvents('dsh', newer), ...agentHistoryEvents('dsh', older)])
    .map(item => [item.role, item.text]), [['user', 'Question'], ['assistant', 'Final reply']]);
  assert.throws(() => agentHistoryNextCursor('dsh', { hasMore: true, records: [] }), /下一页/);
});

test('configured role Agents retain separate remote identities, DSH origins and unavailable providers', () => {
  const binding = { instanceId: 'pc-two', agentId: 'codex', ownerDeviceId: 'owner-pc' };
  const routes = [
    { id: 'one', agentRoleId: 'Example', agentAdapters: ['codex', 'dsh', 'missing-plugin'], dshBaseUrl: 'http://localhost:3000',
      remoteAgentTargets: [{ ...binding, id: remoteAgentTargetKey(binding), provider: 'codex' }] },
    { id: 'two', agentRoleId: 'Example', agentAdapters: ['codex', 'dsh'], dshBaseUrl: 'http://localhost:3001' },
    { id: 'other', agentRoleId: 'Other', agentAdapters: ['other-provider'] },
    { id: 'foreign', agentRoleId: 'Example', agentRoleDeviceId: 'foreign-owner', agentAdapters: ['foreign-provider'] }
  ] as GatewayDefinition[];
  const agents = personaSessionAgents(routes, 'Example');
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.find(agent => agent.id === 'local:codex')?.routes, ['one', 'two']);
  assert.deepEqual(agents.find(agent => agent.binding)?.binding, binding);
  assert.equal(agents.filter(agent => agent.provider === 'dsh').length, 2);
  assert(agents.some(agent => agent.provider === 'missing-plugin'));
});

test('task and history reads keep the original remote owner and cursor, and propagate cancellation', async () => {
  const calls: Array<{ url: string; body: any; signal?: AbortSignal | null }> = [];
  const binding = { instanceId: 'pc-two', agentId: 'codex', ownerDeviceId: 'owner-pc' };
  const agent = { key: 'target', id: remoteAgentTargetKey(binding), provider: 'codex', binding, routes: [] };
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
    if (!init?.body) return Response.json({ code: 0, data: url.includes('/sessions?') ? {items:[{id:'opaque-task',title:'Task'}],nextOffset:50} : { entries: [], nextCursor: 'following' } });
    return Response.json({ code: 0, threads: [{ id: 'opaque-task', title: 'Task' }], nextOffset: 50,
      history: { entries: [], nextCursor: 'following' } });
  }) as typeof fetch;
  const client = createAgentSessionClient(request), signal = new AbortController().signal;
  assert.equal((await client.tasks(agent, 'query', 0, signal)).nextOffset, 50);
  await client.history(agent, 'opaque-task', 'original-cursor', signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, undefined);
  const listUrl = new URL(calls[0].url, 'http://localhost');
  assert.equal(listUrl.pathname, '/api/rabilink/peer/http/owner-pc/manager/api/agent/providers/codex/sessions');
  assert.equal(listUrl.searchParams.get('view'), 'roots');
  assert.equal(listUrl.searchParams.get('previews'), '1');
  const historyUrl = new URL(calls[1].url, 'http://localhost');
  assert.equal(historyUrl.pathname, '/api/rabilink/peer/http/owner-pc/manager/api/agent/providers/codex/sessions/opaque-task/history');
  assert.equal(historyUrl.searchParams.get('cursor'), 'original-cursor');
  assert.equal(historyUrl.searchParams.get('maxBytes'), '2097152');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].signal, signal);
});


test('installed metadata-only thread reader does not prevent native Codex and DSH history reads', async () => {
  const urls: string[] = [];
  const client = createAgentSessionClient((async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal(init?.body, undefined, 'use the published native history API, not an optional flag ignored by older hosts');
    return Response.json({ code: 0, data: url.includes('/codex/')
      ? { entries: [native(1, 'event_msg', { type: 'user_message', message: 'Question' })], nextCursor: null }
      : { records: [dsh(1, 'user/message', { source: { kind: 'user' }, content: 'Question' })], hasMore: false } });
  }) as typeof fetch);
  for (const provider of ['codex', 'dsh']) {
    const page = await client.history({ id: `local:${provider}`, provider, key: provider, routes: [] }, 'task/one', provider === 'dsh' ? '20' : undefined);
    assert.equal(agentHistoryMessages(provider, agentHistoryEvents(provider, page))[0].text, 'Question');
  }
  assert(urls[0].includes('/sessions/task%2Fone/history?'));
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('beforeSeq'), '20');
});

test('explicit DSH origin and enrolled LAN instance keep their original instance-scoped history operation', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const client = createAgentSessionClient((async (url: string, init?: RequestInit) => {
    if (url === '/api/webgui-access') return Response.json({ code: 0, data: { token: 'fixture-token' } });
    const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    return Response.json(url.includes('/lan-agent/') ? { code: 0, result: { data: { history: { entries: [] } } } } : { code: 0, history: { records: [] } });
  }) as typeof fetch);
  await client.history({ id: 'local:dsh', provider: 'dsh', key: 'dsh', routes: [], dshBaseUrl: 'http://localhost:3001' }, 'dsh-task', '12');
  assert.equal(calls[0].body.dshBaseUrl, 'http://localhost:3001');
  assert.deepEqual(calls[0].body.history, { limit: 200, cursor: '12' });
  const binding = { instanceId: 'lan', agentId: 'codex' };
  await client.history({ id: remoteAgentTargetKey(binding), provider: 'codex', key: 'lan', routes: [], binding }, 'lan-task');
  assert(calls[1].url.includes('/instances/lan/agents/codex/threads'));
});


test('the role history grid keeps its implicit minimum within the viewport for long Agent tabs and messages', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/pages/RoleMessageHistoryPage.vue', import.meta.url), 'utf8');
  assert.match(source, /\.page-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});


test('returning to an Agent tab resumes the original cancelled first task/history read', async () => {
  const file = new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url);
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  const source = ts.createSourceFile('agent-history.ts', parsed.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(source)).join('\n');
  const emitted = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const props = reactive({ roleId: 'role', active: true });
  const agent = { id: 'local:codex', provider: 'codex', key: 'codex', routes: [] };
  let taskReads = 0, historyReads = 0, expectedHistoryTask = 'original-task';
  const cancelled = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  const client = {
    agents: async () => [agent],
    members: async () => ({items:[{id:'worker',title:'Worker',parentThreadId:'original-task'}],nextOffset:null}),
    tasks: async (_agent: unknown, _query: string, _offset: number, signal: AbortSignal) => {
      if (++taskReads === 1) return cancelled(signal);
      return { items: [{ id: 'original-task', title: 'Original task' }], nextOffset: null };
    },
    history: async (_agent: unknown, task: string, _cursor: unknown, signal: AbortSignal) => {
      assert.equal(task, expectedHistoryTask);
      if (++historyReads === 1) return cancelled(signal);
      return { entries: [native(1, 'event_msg', { type: 'user_message', message: 'User input' })], nextCursor: null };
    }
  };
  const pane = Object.assign(new EventTarget(), { scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
  const cleanups: Array<() => void> = [];
  const bindings = { computed, nextTick, ref, watch, onBeforeUnmount: (callback: () => void) => cleanups.push(callback),
    defineProps: () => props, usePersonaService: () => ({ fetch, deviceId: '' }), createAgentSessionClient: () => client,
    useI18n: () => ({ t: (text: string) => text, locale: ref('en') }), pluginCatalogStore: { agentAdapters: ref([]) },
    userFacingError: String, agentSessionMembersAvailable, agentHistoryMessages, latestAgentConversationPage,
    chatHistoryScroller: () => pane, chatHistoryViewport: () => ({ top: 0, bottom: 100 }), waitForChatHistoryFrame: async () => false };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(bindings), emitted + ';return {tasks,selectedId,messages,members,chooseMember,chooseRoot,currentSession};')(...Object.values(bindings)))!;
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    await flush(); assert.equal(taskReads, 1);
    props.active = false; await flush(); props.active = true; await flush();
    assert.equal(taskReads, 2); assert.equal(state.tasks.value[0].id, 'original-task');
    state.selectedId.value = 'original-task'; await flush(); assert.equal(historyReads, 1);
    props.active = false; await flush(); props.active = true; await flush();
    assert.equal(historyReads, 2); assert.equal(state.messages.value[0].text, 'User input');
    expectedHistoryTask='worker';state.chooseMember(state.members.value[0]);await flush();
    assert.equal(state.selectedId.value,'original-task');assert.equal(state.currentSession.value.id,'worker');assert.equal(historyReads,3);
    expectedHistoryTask='original-task';state.chooseRoot('original-task');await flush();
    assert.equal(state.currentSession.value.id,'original-task');assert.equal(historyReads,4);
  } finally { cleanups.forEach(cleanup => cleanup()); scope.stop(); }
});


test('session projects normalize Windows prefixes and case while preserving distinct paths and POSIX case', () => {
  assert.equal(agentSessionProject('C:/Work/Project/').key, 'c:/work/project');
  assert.equal(agentSessionProject(String.raw`\\?\C:\Work\Project`).key, 'c:/work/project');
  assert.equal(agentSessionProject(String.raw`\\?\UNC\Server\Share\Project`).key, '//server/share/project');
  assert.equal(agentSessionProject('c:/work/project').title, 'project');
  assert.notEqual(agentSessionProject('/Work/Project').key, agentSessionProject('/work/Project').key);
  assert.notEqual(agentSessionProject('C:/One/Project').key, agentSessionProject('C:/Two/Project').key);
  assert.equal(agentSessionProject('C:/').path, 'C:/');
  assert.deepEqual(agentSessionProject(), {key:'',title:'',path:''});
});

test('Agent sessions offer a persistent project/flat view toggle without changing selected session identity', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  assert.match(source, /:grouped="grouped"/);
  assert.match(source, /@click="grouped = !grouped"/);
  assert.match(source, /localStorage.setItem\(groupingStorageKey/);
  assert.match(source, /@select="chooseRoot"/);
});


test('Codex member pages use the exact owner and parent, preserve pagination and cancellation',async()=>{
  const calls:{url:string;signal?:AbortSignal|null}[]=[];
  const client=createAgentSessionClient((async(url:string,init?:RequestInit)=>{
    calls.push({url,signal:init?.signal});return Response.json({code:0,data:{items:[{id:'child',parentThreadId:'root',agentNickname:'Worker'}],nextOffset:50}});
  }) as typeof fetch);
  const agent={id:'remote',key:'remote',provider:'codex',routes:[],binding:{instanceId:'pc',agentId:'codex',ownerDeviceId:'owner'}};
  const signal=new AbortController().signal;
  assert.equal((await client.members(agent,'root',50,signal)).items[0].agentNickname,'Worker');
  const url=new URL(calls[0].url,'http://local');
  assert.equal(url.pathname,'/api/rabilink/peer/http/owner/manager/api/agent/providers/codex/sessions');
  assert.equal(url.searchParams.get('parentSessionId'),'root');assert.equal(url.searchParams.get('offset'),'50');assert.equal(calls[0].signal,signal);
});

test('DSH list descriptions use its latest completed visible message and retain rows with unavailable history',async()=>{
  const client=createAgentSessionClient((async(url:string,init?:RequestInit)=>{
    if(init?.body)return Response.json({code:0,threads:[{id:'available',title:'Available',updatedAt:'now'},{id:'missing',title:'Missing'}],nextOffset:null});
    if(url.includes('missing'))return Response.json({code:-1,message:'unavailable'},{status:503});
    return Response.json({code:0,data:{records:[dsh(1,'user/message',{source:{kind:'user'},content:'Question'}),dsh(2,'assistant/message',{turn:1,message:{content:'Latest reply'}}),dsh(3,'turn/end',{turn:1,reason:{kind:'completed'}})],hasMore:false}});
  }) as typeof fetch);
  const agent={id:'local:dsh',key:'dsh',provider:'dsh',routes:[]};
  const tasks=await client.tasks(agent,'');
  assert.equal(tasks.items[0].preview,undefined);
  const summaries=new Map<string,any>();await client.previews(agent,tasks.items,task=>summaries.set(task.id,task));
  assert.equal(summaries.get('available').preview,'Latest reply');assert.equal(summaries.get('missing').previewUnavailable,true);
});


test('WorkBuddy native messages preserve page order and skip tools, reasoning, malformed rows and empty messages',()=>{
  const record=(sequence:number,role:string,text:string)=>({sequence,record:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}],timestamp:'2026-11-17T08:00:00Z'}});
  const first=agentHistoryEvents('workbuddy',{entries:[record(1,'user','Question'),null,{sequence:2,record:{type:'reasoning',text:'private'}},{sequence:3,record:{type:'function_call',arguments:'hidden'}},record(4,'assistant','First reply')]});
  const next=agentHistoryEvents('workbuddy',{entries:[record(4,'assistant','First reply'),{sequence:5,record:{type:'function_call_output',text:'hidden'}},record(6,'user','Next question'),record(7,'assistant','Final reply'),record(8,'assistant','')]});
  const merged=[...new Map([...first,...next].map(event=>[event.id,event])).values()];
  assert.deepEqual(agentHistoryMessages('workbuddy',merged).map(item=>[item.role,item.text]),[['user','Question'],['assistant','First reply'],['user','Next question'],['assistant','Final reply']]);
  assert.equal(agentHistoryNextCursor('workbuddy',{nextCursor:'native-workbuddy-cursor'}),'native-workbuddy-cursor');
});

for (const provider of ['workbuddy', 'codex']) {
  test(`${provider} opens the latest visible page and reads earlier pages in reverse page order`, async () => {
    const row = (sequence: number, text: string) => provider === 'codex'
      ? native(sequence, 'event_msg', { type: 'user_message', message: text })
      : { sequence, record: { type: 'message', role: 'user', content: text } };
    const pages = new Map([
      [undefined, { entries: [row(1, 'first')], nextCursor: 'middle' }],
      ['middle', { entries: [row(2, 'middle')], nextCursor: 'latest' }],
      ['latest', { entries: [row(3, 'newest')], nextCursor: 'tail' }],
      ['tail', { entries: [row(4, '')], nextCursor: 'tail', coverage: { pendingTail: true, partial: true } }]
    ]);
    const calls: (string | undefined)[] = [];
    const initialSignal = new AbortController().signal, olderSignal = new AbortController().signal;
    const latest = await latestAgentConversationPage(provider, async (cursor, signal) => {
      assert.equal(signal, calls.length < 4 ? initialSignal : olderSignal);
      calls.push(cursor);
      return pages.get(cursor)!;
    }, initialSignal);

    assert.deepEqual(latest.events.map(event => event.text), ['newest']);
    assert.equal(latest.partial, true);
    const middle = await latest.older!(olderSignal);
    const first = await middle.older!(olderSignal);
    assert.equal(first.older, null);
    assert.deepEqual(calls, [undefined, 'middle', 'latest', 'tail', 'middle', undefined]);
    assert.deepEqual(agentHistoryMessages(provider, [...latest.events, ...middle.events, ...first.events]).map(message => message.text),
      ['first', 'middle', 'newest']);
  });
}

test('DSH opens its newest page without reading older ones until requested', async () => {
  const calls: (string | undefined)[] = [];
  const signal = new AbortController().signal;
  const latest = await latestAgentConversationPage('dsh', async cursor => {
    calls.push(cursor);
    const event = dsh(cursor ? 1 : 5, 'user/message', { source: {kind:'user'}, content: cursor ? 'Older' : 'Newest' });
    return { records: [event], hasMore: !cursor };
  }, signal);
  assert.deepEqual(calls, [undefined]);
  const early = await latest.older!(signal);
  assert.deepEqual(calls, [undefined, '5']);
  assert.equal(early.older, null);
  assert.deepEqual(agentHistoryMessages('dsh', [...latest.events, ...early.events]).map(message => message.text), ['Older', 'Newest']);
});


test('WorkBuddy summaries advance its forward cursor to the latest reply and retain cancellation',async()=>{
  const calls:{body:any;signal?:AbortSignal|null}[]=[];
  const request=(async(_url:string,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));calls.push({body,signal:init?.signal});
    if(body.action==='list')return Response.json({code:0,threads:[{id:'task',title:'WorkBuddy',updatedAt:'2026-11-17T08:00:00Z'}],nextOffset:null});
    return Response.json({code:0,history:{entries:[{sequence:body.history.cursor?2:1,record:{type:'message',role:'assistant',content:[{type:'output_text',text:body.history.cursor?'Latest reply':'Older reply'}]}}],nextCursor:body.history.cursor?null:'next'}});
  }) as typeof fetch;
  const signal=new AbortController().signal,client=createAgentSessionClient(request);
  const agent={id:'local:workbuddy',key:'workbuddy',provider:'workbuddy',routes:[]};
  const page=await client.tasks(agent,'',0,signal);
  assert.equal(page.items[0].preview,undefined);assert.equal(calls.length,1);
  let preview='';await client.previews(agent,page.items,task=>preview=task.preview||'',signal);
  assert.equal(preview,'Latest reply');assert.equal(calls[2].body.history.cursor,'next');assert(calls.every(call=>call.signal===signal));
});

test('task rows return before history, previews use four workers and a slow task does not block other rows',async()=>{
  const pending=new Map<string,(reply:string)=>void>(),started:string[]=[],updates:string[]=[];
  const request=(async(_url:string,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(body.action==='list')return Response.json({code:0,threads:Array.from({length:6},(_,i)=>({id:String(i),title:'Task '+i})),nextOffset:null});
    started.push(body.threadId);
    return await new Promise<Response>((resolve,reject)=>{
      pending.set(body.threadId,text=>resolve(Response.json({code:0,history:{entries:[{sequence:1,record:{type:'message',role:'assistant',content:text}}],nextCursor:null}})));
      init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});
    });
  }) as typeof fetch;
  const client=createAgentSessionClient(request),agent={id:'local:workbuddy',key:'workbuddy',provider:'workbuddy',routes:[]};
  const page=await client.tasks(agent,'');assert.equal(page.items.length,6);assert.equal(started.length,0);
  const controller=new AbortController(),running=client.previews(agent,page.items,task=>updates.push(task.id+':'+task.preview),controller.signal);
  const cancelled=assert.rejects(running);assert.deepEqual(started,['0','1','2','3']);
  pending.get('2')!('Fast reply');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(updates,['2:Fast reply']);assert.deepEqual(started,['0','1','2','3','4']);
  controller.abort();await cancelled;pending.get('0')!('Late reply');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(updates,['2:Fast reply']);assert(!started.includes('5'));
});

test('compact session page keeps task rows without requesting previews after a failed more-page read',async()=>{
  const parsed=parse(fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue',import.meta.url),'utf8'));
  const source=ts.createSourceFile('history.ts',parsed.descriptor.scriptSetup!.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const body=source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(source)).join('\n');
  const emitted=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const props=reactive({roleId:'role',active:true}),cleanups:(()=>void)[]=[];
  const agents=['workbuddy','dsh'].map(provider=>({id:'local:'+provider,key:provider,provider,routes:[]}));
  let failNextPage=false,previewRequests=0;
  const client={agents:async()=>agents,tasks:async()=>{if(failNextPage)throw new Error('More page unavailable');return{items:[{id:'same-task',title:'Task',updatedAt:'2026-11-17T08:00:00Z'}],nextOffset:50};},
    previews:async()=>{previewRequests++;}};
  const bindings={computed,nextTick,ref,watch,onBeforeUnmount:(fn:()=>void)=>cleanups.push(fn),defineProps:()=>props,
    usePersonaService:()=>({fetch,deviceId:''}),createAgentSessionClient:()=>client,useI18n:()=>({t:(text:string)=>text,locale:ref('zh-CN')}),
    pluginCatalogStore:{agentAdapters:ref([])},userFacingError:String,agentSessionMembersAvailable,agentSessionProject};
  const scope=effectScope(),state=scope.run(()=>new Function(...Object.keys(bindings),emitted+';return {tasks,agentKey,query,loadTasks,loadingTasks};')(...Object.values(bindings)))!;
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await nextTick();};
  try{
    await flush();assert.equal(state.tasks.value.length,1);assert.equal(state.loadingTasks.value,false);assert.equal(previewRequests,0);
    failNextPage=true;await state.loadTasks(true);assert.equal(state.tasks.value.length,1);assert.equal(previewRequests,0);
    failNextPage=false;state.query.value='new search';await state.loadTasks();assert.equal(state.tasks.value.length,1);assert.equal(previewRequests,0);
  }finally{cleanups.forEach(fn=>fn());scope.stop();}
});

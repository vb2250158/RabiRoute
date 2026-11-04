import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import test from 'node:test';
import assert from 'node:assert/strict';
import { personaHistoryTaskKey,type PersonaChatReply } from '../../src/shared/personaChatHistory';
import { taskHistoryOutgoing,taskHistoryCounterparty,endpointHistoryTime,historyPageForDisplay,mergeHistoryTaskPage,mergeSavedHistoryWindow } from '../src/historyConversationPresentation';
test('task perspective reverses with selection while preserving true source and recipient',()=>{
  const record:PersonaChatReply={id:'1',receivedAt:'2026-11-04T00:00:00Z',sessionId:'a',sessionTitle:'A',targetSessionId:'b',targetSessionTitle:'B',text:'hello',kind:'agent_delivery'};
  assert.equal(taskHistoryOutgoing(record,personaHistoryTaskKey('a')),true);assert.equal(taskHistoryOutgoing(record,personaHistoryTaskKey('b')),false);
  assert.equal(taskHistoryCounterparty(record,personaHistoryTaskKey('a')),'B');assert.equal(taskHistoryCounterparty(record,personaHistoryTaskKey('b')),'A');
  assert.equal(taskHistoryOutgoing({...record,sourceTaskKey:personaHistoryTaskKey('a'),sourceTaskOwner:{kind:'instance',provider:'codex',agentId:'codex',nodeId:'new-metadata'}},personaHistoryTaskKey('a')),true);
  assert.equal(taskHistoryOutgoing({...record,kind:'user_delivery'},personaHistoryTaskKey('b')),false);
  assert.equal(taskHistoryCounterparty({...record,kind:'user_delivery'}), '\u7528\u6237');
});

test('optional endpoint date labels skip an unformattable time without affecting healthy neighbors',()=>{
  const first=1_700_000_000,last=first+60;
  assert.deepEqual([first,1e20,last].map(endpointHistoryTime),['2023-11-14T22:13:20.000Z','','2023-11-14T22:14:20.000Z']);
  assert.equal(endpointHistoryTime(Number.NaN),'');
});

test('saved pages retain write order across skewed clocks, equal times and legacy sequence metadata',()=>{
  const page=[{id:'first',time:90,sequence:7},{id:'legacy',time:10},{id:'last',time:90,sequence:1}];
  const original=structuredClone(page);
  assert.deepEqual(historyPageForDisplay(page,true,false).map(row=>row.id),['first','legacy','last']);
  assert.deepEqual(historyPageForDisplay(page,false,false).map(row=>row.id),['last','legacy','first']);
  // Live QQ still follows its protocol timestamp, with stable ties in either view.
  assert.deepEqual(historyPageForDisplay(page,true,true).map(row=>row.id),['legacy','first','last']);
  assert.deepEqual(historyPageForDisplay(page,false,true).map(row=>row.id),['first','last','legacy']);
  assert.deepEqual(page,original);
});

test('saved refresh preserves physical order, replaces overlapping data and does not bridge a missing page',()=>{
  const current=[{id:'a',time:90,text:'old a'},{id:'b',time:10,text:'old b'}];
  const page=[{id:'b',time:10,text:'updated b'},{id:'c',time:5,text:'new c'}];
  const original=structuredClone({current,page});
  const key=(row:{id:string})=>row.id;
  const merged=mergeSavedHistoryWindow(current,page,true,key);
  assert.deepEqual(merged.entries.map(row=>row.id),['a','b','c']);
  assert.equal(merged.entries[1]!.text,'updated b');
  assert.equal(merged.newerAvailable,false);
  const reading=mergeSavedHistoryWindow(current,page,false,key);
  assert.deepEqual(reading.entries,merged.entries);assert.equal(reading.newerAvailable,true);
  const gap=mergeSavedHistoryWindow(current,[{id:'gap',time:1,text:'disjoint'}],true,key);
  assert.equal(gap.entries,current);assert.equal(gap.newerAvailable,true);
  assert.deepEqual({current,page},original);
  const expandedPage=[{id:'earlier',time:999,text:'earlier write'},...current];
  assert.deepEqual(mergeSavedHistoryWindow(current,expandedPage,true,key).entries.map(row=>row.id),['earlier','a','b']);
  // An older API page is prepended in its own write order, without comparing its clock.
  const older=historyPageForDisplay([{id:'older',time:999,text:'older write'}],true,false);
  assert.deepEqual([...older,...merged.entries].map(row=>row.id),['older','a','b','c']);
});

test('saved refresh retains the existing reading window and clips only its existing boundary',()=>{
  const current=Array.from({length:200},(_,id)=>({id:String(id),time:1000-id}));
  const page=[current[199]!,{id:'200',time:-5}];
  const key=(row:{id:string})=>row.id;
  const latest=mergeSavedHistoryWindow(current,page,true,key);
  assert.equal(latest.entries.length,200);assert.equal(latest.entries[0]!.id,'1');assert.equal(latest.entries.at(-1)!.id,'200');assert.equal(latest.newerAvailable,false);
  const reading=mergeSavedHistoryWindow(current,page,false,key);
  assert.equal(reading.entries.length,200);assert.equal(reading.entries[0]!.id,'0');assert.equal(reading.entries.at(-1)!.id,'199');assert.equal(reading.newerAvailable,true);
  assert.equal(current[0]!.id,'0');assert.equal(current.at(-1)!.id,'199');
});

test('task catalog refresh follows indexed write order while retaining loaded task identities',()=>{
  const current=[{key:'a',receivedAt:'2099-01-01',title:'A'},{key:'b',receivedAt:'2000-01-01',title:'B'},{key:'selected-old',receivedAt:'2100-01-01',title:'Selected'}];
  const page=[{key:'b',receivedAt:'2000-01-01',title:'Updated B'},{key:'new',receivedAt:'1990-01-01',title:'New'},{key:'a',receivedAt:'2099-01-01',title:'A'}];
  const original=structuredClone({current,page});
  const refresh=mergeHistoryTaskPage(current,page,false);
  assert.deepEqual(refresh.map(task=>task.key),['b','new','a','selected-old']);
  assert.equal(refresh[0]!.title,'Updated B');assert.equal(refresh.at(-1),current[2]);
  const older=[{key:'a',receivedAt:'2099-01-01',title:'Updated A'},{key:'older',receivedAt:'2200-01-01',title:'Older write'}];
  const appended=mergeHistoryTaskPage(refresh,older,true);
  assert.deepEqual(appended.map(task=>task.key),['b','new','a','selected-old','older']);
  assert.equal(appended[2]!.title,'Updated A');
  assert.deepEqual({current,page},original);
});

test('task catalog fills a disjoint latest-page gap before the retained older tail',()=>{
  const old=[{key:'old-a'},{key:'selected-old'},{key:'old-b'}];
  const latest=[{key:'new-a'},{key:'new-b'}];
  const refreshed=mergeHistoryTaskPage(old,latest,false);
  assert.deepEqual(refreshed.map(row=>row.key),['new-a','new-b','old-a','selected-old','old-b']);
  const gap=[{key:'gap-a'},{key:'gap-b'}];
  const prefix=mergeHistoryTaskPage(latest,gap,true);
  const filled=mergeHistoryTaskPage(refreshed,prefix,false);
  assert.deepEqual(filled.map(row=>row.key),['new-a','new-b','gap-a','gap-b','old-a','selected-old','old-b']);
  // Following the new cursor through the old page neither duplicates nor moves the selection.
  const continuous=mergeHistoryTaskPage(prefix,old,true);
  const joined=mergeHistoryTaskPage(filled,continuous,false);
  assert.deepEqual(joined.map(row=>row.key),filled.map(row=>row.key));
  assert.equal(joined.find(row=>row.key==='selected-old'),old[1]);
  const oldest=mergeHistoryTaskPage(continuous,[{key:'oldest'}],true);
  assert.deepEqual(mergeHistoryTaskPage(joined,oldest,false).map(row=>row.key),[...filled.map(row=>row.key),'oldest']);
});

test('an old task moving into the latest page cannot prove the unseen interval is continuous',()=>{
  const retained=[{key:'old-a'},{key:'moved-task'},{key:'selected-old'}];
  const latest=[{key:'new-a'},{key:'moved-task'}];
  const refreshed=mergeHistoryTaskPage(retained,latest,false);
  const next=[{key:'gap-a'},{key:'gap-b'}];
  const prefix=mergeHistoryTaskPage(latest,next,true);
  assert.deepEqual(mergeHistoryTaskPage(refreshed,prefix,false).map(row=>row.key),['new-a','moved-task','gap-a','gap-b','old-a','selected-old']);
  assert.deepEqual(retained.map(row=>row.key),['old-a','moved-task','selected-old']);
});

/** Execute only the fixed repository SFC's actual load body against private in-memory API state. */
function actualCatalogLoader(component:'PersonaTaskHistory'|'EndpointConversationHistory',bindings:Record<string,unknown>):(more?:boolean)=>Promise<void> {
  const file=new URL(`../src/components/${component}.vue`,import.meta.url);
  const {descriptor,errors}=parse(readFileSync(file,'utf8'),{filename:file.pathname});
  assert.deepEqual(errors,[]);assert.ok(descriptor.scriptSetup);
  const source=ts.createSourceFile(component+'.ts',descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const load=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='load');
  assert.ok(load);
  const compiled=ts.transpileModule(load.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function(...Object.keys(bindings),'let request,catalogQuery="",catalogPages=[];'+compiled+';return load;')(...Object.values(bindings));
}

test('actual task refresh follows the new cursor through a disjoint gap and keeps the selected loaded task',async()=>{
  const row=(key:string)=>({key,title:key,preview:'',receivedAt:'2000-01-01',sessionId:key});
  const old=Array.from({length:50},(_,i)=>row('old-'+i));
  const latest=Array.from({length:50},(_,i)=>row('new-'+i));
  const gap=Array.from({length:50},(_,i)=>row('new-'+(50+i)));
  const pages=[{items:old,nextCursor:'old-boundary'},{items:latest,nextCursor:'new-boundary'},{items:gap,nextCursor:'gap-boundary'},{items:old,nextCursor:null}];
  const calls:string[]=[];
  const tasks={value:[] as ReturnType<typeof row>[]},selectedKey={value:''},cursor={value:null as string|null};
  const selected={get value(){return tasks.value.find(task=>task.key===selectedKey.value);}};
  const load=actualCatalogLoader('PersonaTaskHistory',{props:{roleId:'fixture',category:'agent'},tasks,selectedKey,selected,cursor,search:{value:''},loading:{value:false},error:{value:''},
    read:async(query:URLSearchParams)=>{calls.push(query.toString());assert.ok(pages.length);return pages.shift()!;},mergeHistoryTaskPage,userFacingError:String});
  await load();selectedKey.value='old-17';
  await load();assert.equal(cursor.value,'new-boundary');assert.equal(selected.value?.key,'old-17');
  await load(true);assert.equal(new URLSearchParams(calls[2]).get('cursor'),'new-boundary');
  assert.deepEqual(tasks.value.map(task=>task.key),[...latest,...gap,...old].map(task=>task.key));
  await load(true);assert.equal(new URLSearchParams(calls[3]).get('cursor'),'gap-boundary');
  assert.equal(tasks.value.length,150);assert.equal(new Set(tasks.value.map(task=>task.key)).size,150);assert.equal(cursor.value,null);assert.equal(selected.value?.key,'old-17');
});

test('actual endpoint directory refresh traverses new key pages before the old cursor without losing its selection',async()=>{
  const row=(conversationKey:string)=>({conversationKey,target:conversationKey,title:conversationKey,time:1});
  const old=Array.from({length:100},(_,i)=>row('z-'+i.toString().padStart(3,'0')));
  const latest=Array.from({length:100},(_,i)=>row('a-'+i.toString().padStart(3,'0')));
  const gap=Array.from({length:100},(_,i)=>row('b-'+i.toString().padStart(3,'0')));
  const pages=[{conversations:old,nextConversationCursor:'z-099'},{conversations:latest,nextConversationCursor:'a-099'},{conversations:gap,nextConversationCursor:'b-099'},{conversations:old,nextConversationCursor:null}];
  const calls:string[]=[];
  const conversations={value:[] as ReturnType<typeof row>[]},selectedKey={value:''},cursor={value:null as string|null};
  const load=actualCatalogLoader('EndpointConversationHistory',{props:{roleId:'fixture',adapter:'system'},conversations,selectedKey,cursor,loading:{value:false},error:{value:''},t:(text:string)=>text,userFacingError:String,
    fetch:async(url:string)=>{calls.push(url);assert.ok(pages.length);const data=pages.shift()!;return {ok:true,json:async()=>({code:0,data})};}});
  await load();selectedKey.value='z-017';
  await load();assert.equal(cursor.value,'a-099');assert.equal(selectedKey.value,'z-017');
  await load(true);assert.equal(new URL(calls[2]!,'http://fixture').searchParams.get('cursor'),'a-099');
  assert.equal(conversations.value.length,300);assert(gap.every(row=>conversations.value.some(item=>item.conversationKey===row.conversationKey)));
  await load(true);assert.equal(new URL(calls[3]!,'http://fixture').searchParams.get('cursor'),'b-099');
  assert.equal(conversations.value.length,300);assert.equal(new Set(conversations.value.map(row=>row.conversationKey)).size,300);assert.equal(cursor.value,null);assert.equal(selectedKey.value,'z-017');
});

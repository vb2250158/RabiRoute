import { readFileSync } from 'node:fs';
import { computed, ref, type Ref, type ComputedRef } from 'vue';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { historyPageForDisplay,mergeSavedHistoryWindow } from '../src/historyConversationPresentation';
import assert from 'node:assert/strict';
import test from 'node:test';
import {qqDisplayParts,qqHistoryRecord,mergeQqHistoryWindow} from '../src/qqMessagePresentation';
import {qqPreviewRead,qqNavigationRead} from '../src/qqPreviewQueue';
const selection={routeId:'test',kind:'group' as const,target:'10001'};
const row=(id:number)=>qqHistoryRecord({messageId:String(id),time:id,sender:'20002',text:`message ${id}`},selection);

test('legacy text/@/reply are not files; unnamed real media and old files remain readable',()=>{
  const parts=qqDisplayParts('晚一点',undefined,[{kind:'text'},{kind:'at'},{kind:'reply'},{name:'old.pdf'},{kind:'image'},{kind:'audio'}]);
  assert.deepEqual(parts.map(p=>p.kind),['text','media','media','media']);
  assert.deepEqual(parts.filter(p=>p.kind==='media').map(p=>[p.index,p.mediaKind]),[[0,'file'],[1,'image'],[2,'record']]);
  assert.deepEqual(qqDisplayParts('[CQ:image,file=literal]',[{kind:'text',text:'[CQ:image,file=literal]'}],[{kind:'file',name:'not-an-extra-file'}]),[{kind:'text',text:'[CQ:image,file=literal]'}]);
});
test('new messages merge without dropping a loaded older page or inventing a bridge across a gap',()=>{
  const current=Array.from({length:60},(_,i)=>row(i+1));
  const merged=mergeQqHistoryWindow(current,Array.from({length:50},(_,i)=>row(i+12)),true);
  assert.equal(merged.entries.length,61);assert.equal(merged.entries[0]?.messageId,'1');assert.equal(merged.entries.at(-1)?.messageId,'61');
  const gap=mergeQqHistoryWindow(current,[row(90),row(91)],false);
  assert.equal(gap.entries,current);assert.equal(gap.newerAvailable,true);
  const sameSecond=mergeQqHistoryWindow([row(1),row(2)].map(r=>({...r,time:100})),[row(3),row(4)].map(r=>({...r,time:100})),false);
  assert.equal(sameSecond.newerAvailable,true);
  const bounded=mergeQqHistoryWindow(Array.from({length:200},(_,i)=>row(i+1)),[row(200),row(201)],false);
  assert.equal(bounded.entries[0]?.messageId,'1');assert.equal(bounded.entries.at(-1)?.messageId,'200');assert.equal(bounded.newerAvailable,true);
});
test('preview lane releases rejected work and skips cancelled queued requests',async()=>{
  let release!:()=>void,started=false,third=false;
  const first=qqPreviewRead(new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve;}));
  await Promise.resolve();
  const aborted=new AbortController();
  const second=qqPreviewRead(aborted.signal,async()=>{started=true;});
  const rejection=assert.rejects(second);aborted.abort();
  const last=qqPreviewRead(new AbortController().signal,async()=>{third=true;});
  release();await first;await rejection;await last;assert.equal(started,false);assert.equal(third,true);
});

test('navigation uses its own single lane and remains available during a slow preview',async()=>{
  const signal=new AbortController().signal;
  let releasePreview!:()=>void,releaseNavigation!:()=>void,active=0,maximum=0,secondStarted=false;
  const enter=()=>{active++;maximum=Math.max(maximum,active);};
  const preview=qqPreviewRead(signal,async()=>{enter();await new Promise<void>(resolve=>releasePreview=resolve);active--;});
  const first=qqNavigationRead(signal,async()=>{enter();await new Promise<void>(resolve=>releaseNavigation=resolve);active--;});
  const second=qqNavigationRead(signal,async()=>{enter();secondStarted=true;active--;});
  await Promise.resolve();assert.equal(active,2);assert.equal(secondStarted,false);
  releaseNavigation();await first;await second;
  assert.equal(secondStarted,true);assert.equal(active,1);assert.equal(maximum,2);
  releasePreview();await preview;assert.equal(active,0);
});

test('configured QQ sources remain exact; missing route and old instance do not impersonate current chats',async()=>{
  const {qqConfiguredRoute,mergeQqConversations}=await import('../src/qqMessagePresentation');
  const routes=[{routeId:'route',name:'Current QQ',instanceId:'napcat-1'},{routeId:'other',name:'Other QQ',instanceId:'napcat-1'}];
  const current={conversationKey:'current',gatewayId:'route',instanceId:'napcat-1',kind:'group' as const,target:'10001',time:200,preview:'current'};
  const legacy=[{...current,conversationKey:'default',instanceId:'default'},{...current,conversationKey:'missing-route',gatewayId:undefined},{...current,conversationKey:'missing-instance',instanceId:undefined}];
  assert.equal(qqConfiguredRoute(current,routes),routes[0]);
  assert.equal(qqConfiguredRoute({...current,gatewayId:'other'},routes),routes[1]);
  for(const row of legacy)assert.equal(qqConfiguredRoute(row,routes),undefined);
  const merged=mergeQqConversations([current],legacy);assert.equal(merged.length,4);assert.deepEqual(merged.map(row=>row.conversationKey),['current','default','missing-route','missing-instance']);
  assert.equal(qqConfiguredRoute({...current,instanceId:undefined},[{routeId:'route',name:'Legacy configured'}])?.name,'Legacy configured');
});

/** Only this fixed repository SFC is evaluated; API/message values remain private data. */
function actualEndpointHistory(pages:unknown[]) {
  const file=new URL('../src/components/MessageEndpointHistory.vue',import.meta.url);
  const {descriptor,errors}=parse(readFileSync(file,'utf8'));
  assert.deepEqual(errors,[]);assert.ok(descriptor.scriptSetup);
  const source=ts.createSourceFile('endpoint.ts',descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const body=source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(source)).join('\n');
  const emitted=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const props={roleId:'fixture',adapter:'napcat',title:'Fixture',version:1,active:true,bubble:true,qqLive:true,qqSelection:selection,ownQqId:'20002',conversationKey:'original-conversation'};
  const watches:{source:()=>unknown;callback:(value:unknown)=>void}[]=[];
  const calls:string[]=[];let started!:()=>void;const firstRead=new Promise<void>(resolve=>{started=resolve;});
  const bindings={computed,ref,defineProps:()=>props,defineEmits:()=>()=>{},useI18n:()=>({t:(text:string)=>text,locale:ref('en')}),
    usePersonaService:()=>({fetch:async(url:string)=>{calls.push(url);started();assert.ok(pages.length,'Every read must consume an explicit private page');const data=await pages.shift();if(data instanceof Error)throw data;return {ok:true,json:async()=>({code:0,data})};}}),
    watch:(source:()=>unknown,callback:(value:unknown)=>void)=>{watches.push({source,callback});},onBeforeUnmount:()=>{},onDeactivated:()=>{},onActivated:()=>{},nextTick:async()=>{},
    qqNavigationRead,qqHistoryRecord,mergeQqHistoryWindow,historyPageForDisplay,mergeSavedHistoryWindow,userFacingError:String,waitForChatHistoryFrame:async()=>false,
    window:{innerHeight:800,addEventListener:()=>{},removeEventListener:()=>{}}};
  const state=new Function(...Object.keys(bindings),emitted+';return {load,entries,cursor,skippedCount,unreadablePage,showEmptyHistory,error};')(...Object.values(bindings)) as {
    load(older?:boolean,update?:boolean):Promise<void>;entries:Ref<ReturnType<typeof row>[]>;cursor:Ref<string|null>;skippedCount:Ref<number>;unreadablePage:Ref<boolean>;showEmptyHistory:ComputedRef<boolean>;error:Ref<string>};
  return {...state,calls,props,firstRead,accountChanged:(id:string)=>{const account=watches.find(watch=>watch.source()===props.ownQqId);assert.ok(account);props.ownQqId=id;account.callback(id);}};
}
const livePage=(entries:unknown[],skippedCount?:number)=>({routeId:selection.routeId,instanceId:'fixture-instance',entries,nextCursor:entries.length?'100':null,cursorStalled:!entries.length&&Boolean(skippedCount),completenessUnknown:true,...(skippedCount?{skippedCount}:{})});
const nativeRow=(id:number)=>({messageId:String(id),time:id,sender:'20002',text:'readable '+id,kind:selection.kind,target:selection.target,attachments:[]});

test('actual live history keeps healthy rows and original selection while reporting skipped rows locally',async()=>{
  const state=actualEndpointHistory([livePage([nativeRow(101),nativeRow(100)],1),livePage([nativeRow(99)])]);
  await state.load();
  assert.equal(state.error.value,'');assert.equal(state.skippedCount.value,1);assert.equal(state.unreadablePage.value,false);assert.equal(state.showEmptyHistory.value,false);
  assert.deepEqual(state.entries.value.map(row=>row.messageId),['100','101']);assert.equal(state.cursor.value,'100');
  assert(state.entries.value.every(row=>row.gatewayId===selection.routeId&&row.target===selection.target));
  await state.load(true);
  assert.equal(new URL(state.calls[1]!,'http://fixture').searchParams.get('cursor'),'100');
  assert.deepEqual(state.entries.value.map(row=>row.messageId),['99','100','101']);assert.equal(state.skippedCount.value,0);assert.equal(state.unreadablePage.value,false);
  assert.equal(state.props.conversationKey,'original-conversation');assert.deepEqual(state.props.qqSelection,selection);
});

test('an all-skipped live page is incomplete rather than empty and never erases healthy cached messages',async()=>{
  const state=actualEndpointHistory([livePage([],2),livePage([nativeRow(100)]),livePage([],3)]);
  await state.load();assert.deepEqual(state.entries.value,[]);assert.equal(state.cursor.value,null);
  assert.equal(state.skippedCount.value,2);assert.equal(state.unreadablePage.value,true);assert.equal(state.showEmptyHistory.value,false);assert.equal(state.error.value,'');
  assert.equal(state.calls.length,1,'a skipped page does not schedule another upstream read');
  await state.load();assert.equal(state.skippedCount.value,0);assert.equal(state.unreadablePage.value,false);assert.equal(state.entries.value[0]?.messageId,'100');
  await state.load();assert.equal(state.entries.value[0]?.messageId,'100');assert.equal(state.cursor.value,null);assert.equal(state.skippedCount.value,3);assert.equal(state.unreadablePage.value,true);assert.equal(state.showEmptyHistory.value,false);
  assert.equal(state.calls.length,3,'no retry is invented for a stalled all-skipped page');
});

test('skipped-page notice follows the cached account and a failed refresh retains readable data',async()=>{
  const state=actualEndpointHistory([livePage([nativeRow(100)],1),new Error('fixture unavailable')]);
  await state.load();await state.load(false,true);
  assert.match(state.error.value,/fixture unavailable/);assert.equal(state.entries.value[0]?.messageId,'100');assert.equal(state.skippedCount.value,1);
  state.props.active=false;state.accountChanged('30003');
  assert.deepEqual(state.entries.value,[]);assert.equal(state.cursor.value,null);assert.equal(state.skippedCount.value,0);assert.equal(state.unreadablePage.value,false);
  assert.equal(state.calls.length,2,'an inactive account switch does not query another account');
});

test('a late skipped-page result from the previous account cannot restore its notice or messages',async()=>{
  let release!:(page:unknown)=>void;const page=new Promise(resolve=>{release=resolve;});
  const state=actualEndpointHistory([page]);const loading=state.load();await state.firstRead;
  state.props.active=false;state.accountChanged('30003');
  release(livePage([nativeRow(100)],1));await loading;
  assert.deepEqual(state.entries.value,[]);assert.equal(state.skippedCount.value,0);assert.equal(state.unreadablePage.value,false);assert.equal(state.cursor.value,null);assert.equal(state.error.value,'');assert.equal(state.calls.length,1);
});

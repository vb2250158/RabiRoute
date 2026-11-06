import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { qqConfiguredRoute, qqConversationIdentity } from '../src/qqMessagePresentation';
import { conversationListWidth, conversationPaneWidths, HISTORY_DEFAULT_WIDTH, HISTORY_DETAILS_WIDTH_KEY } from '../src/historyConversationLayout';

test('all channels reserve reading space without discarding a wider stored preference',()=>{
  assert.equal(conversationListWidth(360,1200,true),360);
  assert.equal(conversationListWidth(360,800,true),242);
  assert.equal(conversationListWidth(360,1200,true),360);
  assert.equal(conversationListWidth(360,800,false),360);
  assert.equal(conversationListWidth(180,1200,false),200);
  assert.equal(conversationListWidth(900,1600,false),420);
  assert.equal(conversationListWidth(Number.NaN,1200,false),HISTORY_DEFAULT_WIDTH);
});


const layoutRoot = new URL('../../', import.meta.url);
const componentPath = (name:string) => new URL(`src/plugins/io.rabiroute.manager.persona/web/components/${name}.vue`,layoutRoot);
function actualLayoutHandlers(hasDetails = () => true) {
  const mounted:(()=>void)[]=[],unmounted:(()=>void)[]=[],deactivated:(()=>void)[]=[], listeners=new Map<string,()=>void>();
  const storage=new Map<string,string>([['rabiroute.history.conversation-list-width','360']]);
  const window={innerWidth:1440,addEventListener:(name:string,callback:()=>void)=>listeners.set(name,callback),removeEventListener:(name:string)=>listeners.delete(name)};
  let resize!:(entries:unknown[])=>void,disconnected=false;
  const ResizeObserver=class{constructor(callback:(entries:unknown[])=>void){resize=callback;}observe(){}disconnect(){disconnected=true;}};
  const source=readFileSync(new URL('ribiwebgui/src/historyConversationLayout.ts',layoutRoot),'utf8');
  const emitted=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code;
  const module={exports:{} as any};
  new Function('require','module','exports','window','localStorage','ResizeObserver',emitted)(()=>({computed,ref,watch,
    onMounted:(fn:()=>void)=>mounted.push(fn),onBeforeUnmount:(fn:()=>void)=>unmounted.push(fn),onDeactivated:(fn:()=>void)=>deactivated.push(fn)}),module,module.exports,window,
    {getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},ResizeObserver);
  const state=module.exports.useHistoryConversationLayout(ref({clientWidth:1200}),hasDetails);
  mounted.forEach(fn=>fn());
  return {state,storage,window,listeners,resize:(width:number)=>resize([{contentRect:{width}}]),deactivate:()=>deactivated.forEach(fn=>fn()),
    unmount:()=>unmounted.forEach(fn=>fn()),disconnected:()=>disconnected};
}
function sfcSetup(name:string,bindings:Record<string,unknown>,expose:string) {
  const parsed=parse(readFileSync(componentPath(name),'utf8'));assert.deepEqual(parsed.errors,[]);
  const source=ts.createSourceFile('fixture.ts',parsed.descriptor.scriptSetup!.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const body=source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(source)).join('\n');
  const emitted=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return new Function(...Object.keys(bindings),emitted+`;return {${expose}};`)(...Object.values(bindings));
}

test('actual width key/drag handlers retain a wider preference at the visible maximum and release pointer ownership',()=>{
  const f=actualLayoutHandlers(),state=f.state;
  assert.equal(state.width.value,360);f.resize(800);assert.equal(state.width.value,242);
  let prevented=0;state.key({key:'ArrowRight',preventDefault:()=>prevented++});
  assert.equal(prevented,1);f.resize(1200);assert.equal(state.width.value,360);
  f.resize(800);
  const capture=new Set<number>(),element={setPointerCapture:(id:number)=>capture.add(id),hasPointerCapture:(id:number)=>capture.has(id),releasePointerCapture:(id:number)=>capture.delete(id)};
  state.start({button:0,pointerId:7,clientX:100,currentTarget:element,preventDefault(){}});
  assert.equal(capture.has(7),true);state.move({pointerId:7,clientX:120});state.stop();
  assert.equal(capture.size,0);f.resize(1200);assert.equal(state.width.value,360);
  state.key({key:'ArrowLeft',preventDefault(){}});assert.equal(state.width.value,344);
  state.reset();assert.equal(state.width.value,HISTORY_DEFAULT_WIDTH);
  state.start({button:0,pointerId:8,clientX:100,currentTarget:element,preventDefault(){}});
  f.deactivate();assert.equal(capture.size,0);assert.equal(state.dragging.value,false);
  f.unmount();assert.equal(f.disconnected(),true);assert.equal(f.listeners.size,0);
});

test('actual shared layout keeps controlled mobile list/info state during background key aliases',async()=>{
  const props=reactive({items:[],selected:'stored-key',search:'',detailOpen:false,infoOpen:true,hasDetails:true});
  const events:unknown[][]=[];const scope=effectScope();
  const state=scope.run(()=>sfcSetup('HistoryConversationLayout',{computed,ref,watch,defineProps:()=>props,
    defineEmits:()=>((...args:unknown[])=>{events.push(args);if(args[0]==='update:detailOpen')props.detailOpen=Boolean(args[1]);if(args[0]==='update:infoOpen')props.infoOpen=Boolean(args[1]);}),
    useI18n:()=>({t:(x:string)=>x,locale:ref('en')}),useHistoryConversationLayout:()=>({width:ref(260),maximum:ref(420),dragging:ref(false),start(){},move(){},stop(){},key(){},reset(){}}),
    qqConversationTime:()=>''},'detailOpen,infoOpen,choose,back'))!;
  try {
    props.selected='qq-live:key';await nextTick();assert.equal(state.detailOpen.value,false);assert.equal(state.infoOpen.value,true);
    assert.equal(events.some(row=>row[0]==='update:detailOpen'),false);
    state.choose('qq-live:key');assert.equal(state.detailOpen.value,true);
    state.back();assert.equal(state.detailOpen.value,false);assert.ok(events.some(row=>row[0]==='back'));
  }finally{scope.stop();}
});

test('actual QQ handlers preserve members and browser position across a canonical key alias, then close on a different source',async()=>{
  const props=reactive({roleId:'fixture',version:0,messageVersion:0,active:false,routes:[{routeId:'route',instanceId:'instance',name:'Current'}]});
  const cleanup:(()=>void)[]=[],scroll:number[]=[];
  const window={scrollY:700,addEventListener(){},removeEventListener(){},scrollTo:(_x:number,y:number)=>{scroll.push(y);window.scrollY=y;}};
  const scope=effectScope();
  const state=scope.run(()=>sfcSetup('NapcatConversationHistory',{computed,ref,watch,nextTick,onBeforeUnmount:(fn:()=>void)=>cleanup.push(fn),defineProps:()=>props,
    useDisplay:()=>({width:ref(390)}),useI18n:()=>({t:(x:string)=>x,locale:ref('en')}),usePersonaService:()=>({fetch:async()=>{throw new Error('Unexpected read in this layout-only fixture');}}),
    window,qqConfiguredRoute,qqConversationIdentity,userFacingError:String,waitForChatHistoryFrame:async(signal:AbortSignal)=>!signal.aborted},
    'conversations,selectedKey,membersOpen,detailOpen,showList,choose'))!;
  const stored={conversationKey:'stored-key',gatewayId:'route',instanceId:'instance',kind:'group',target:'10001',time:1,preview:''};
  try {
    state.conversations.value=[stored];state.selectedKey.value=stored.conversationKey;await nextTick();
    state.detailOpen.value=true;state.showList();state.membersOpen.value=true;
    const canonical={...stored,conversationKey:'qq-live:key',storedConversationKey:stored.conversationKey};
    state.conversations.value=[canonical];state.selectedKey.value=canonical.conversationKey;await nextTick();
    assert.equal(state.detailOpen.value,false);assert.equal(state.membersOpen.value,true);
    window.scrollY=0;await state.choose(canonical);assert.equal(state.detailOpen.value,true);assert.equal(scroll.at(-1),700);
    state.membersOpen.value=true;
    const different={...canonical,conversationKey:'other-source',gatewayId:'other-route'};
    state.conversations.value=[canonical,different];state.selectedKey.value=different.conversationKey;await nextTick();
    assert.equal(state.membersOpen.value,false);
  }finally{cleanup.forEach(fn=>fn());scope.stop();}
});

test('shared mobile navigation stays under the app header and tabs without a second message scroller',()=>{
  const source=readFileSync(componentPath('HistoryConversationLayout'),'utf8');
  assert.match(source,/history-mobile-actions\{[^}]*position:sticky;top:112px;/);
  assert.doesNotMatch(source,/history-detail\{[^}]*overflow-y:(?:auto|scroll)/);
});


test('both side panes preserve the reading column within their visible bounds',()=>{
  for(const available of [800,1000,1200,1600]) for(const left of [200,260,360,420,NaN]) for(const right of [180,222,320,420,NaN]) {
    const sizes=conversationPaneWidths(left,right,available,true);
    assert.ok(sizes.list>=200&&sizes.list<=420);
    assert.ok(sizes.info>=180&&sizes.info<=420);
    assert.ok(available-sizes.list-sizes.info-24>=312);
  }
  assert.equal(conversationPaneWidths(360,360,1200,false).info,0);
});

test('actual right pane drag reverses pointer direction, persists independently and survives a narrow viewport',()=>{
  const f=actualLayoutHandlers(),state=f.state;
  const capture=new Set<number>(),element={setPointerCapture:(id:number)=>capture.add(id),hasPointerCapture:(id:number)=>capture.has(id),releasePointerCapture:(id:number)=>capture.delete(id)};
  assert.equal(state.detailsWidth.value,222);
  state.details.start({button:0,pointerId:9,clientX:900,currentTarget:element,preventDefault(){}});
  state.details.move({pointerId:9,clientX:860});
  assert.equal(state.detailsWidth.value,262);
  assert.equal(state.width.value,360);
  assert.equal(f.storage.has(HISTORY_DETAILS_WIDTH_KEY),false,'a pointer move does not synchronously write browser storage');
  state.details.stop();
  assert.equal(capture.size,0);assert.equal(f.storage.get(HISTORY_DETAILS_WIDTH_KEY),'262');
  assert.equal(f.storage.get('rabiroute.history.conversation-list-width'),'360');
  f.resize(800);assert.equal(state.width.value,202);assert.equal(state.detailsWidth.value,262);
  state.details.key({key:'ArrowLeft',preventDefault(){}}); // Already at the visible maximum.
  f.resize(1200);assert.equal(state.width.value,360);assert.equal(state.detailsWidth.value,262);
  state.details.key({key:'ArrowRight',preventDefault(){}});assert.equal(state.detailsWidth.value,246);
  state.details.key({key:'Home',preventDefault(){}});assert.equal(state.detailsWidth.value,180);
  state.details.reset();assert.equal(state.detailsWidth.value,222);
  state.details.start({button:0,pointerId:10,clientX:900,currentTarget:element,preventDefault(){}});
  f.window.innerWidth=900;f.listeners.get('resize')!();
  assert.equal(capture.size,0);assert.equal(state.details.dragging.value,false);assert.equal(state.detailsWidth.value,0);
  const saved=f.storage.get(HISTORY_DETAILS_WIDTH_KEY);
  state.details.key({key:'End',preventDefault(){throw new Error('Hidden separator accepted a key');}});
  assert.equal(f.storage.get(HISTORY_DETAILS_WIDTH_KEY),saved);
  f.window.innerWidth=1440;f.listeners.get('resize')!();assert.equal(state.detailsWidth.value,222);
  state.details.start({button:0,pointerId:11,clientX:900,currentTarget:element,preventDefault(){}});
  state.start({button:0,pointerId:12,clientX:100,currentTarget:element,preventDefault(){}});
  assert.equal(capture.has(11),false,'starting another separator releases the previous pointer');
  f.deactivate();assert.equal(capture.size,0);f.unmount();
});

test('shared details separator uses keyboard and pointer handlers and disappears with the desktop details rail',()=>{
  const source=readFileSync(componentPath('HistoryConversationLayout'),'utf8');
  assert.match(source,/history-info-splitter[^>]*role="separator"/);
  assert.match(source,/@pointermove="details.move"/);assert.match(source,/@keydown="details.key"/);
  assert.match(source,/minmax\(0,1fr\) 12px var\(--history-details-width\)/);
  assert.match(source,/history-info,.history-info-splitter\{display:none;/);
});


test('actual shared SFC binds the measured right width into its grid style',()=>{
  const detailsWidth=ref(222),scope=effectScope();
  const noop=()=>{};
  const state=scope.run(()=>sfcSetup('HistoryConversationLayout',{computed,ref,watch,defineProps:()=>({selected:'',hasDetails:true}),defineEmits:()=>noop,
    useI18n:()=>({t:(text:string)=>text,locale:ref('en')}),qqConversationTime:()=>'',
    useHistoryConversationLayout:()=>({width:ref(260),maximum:ref(420),detailsWidth,detailsMaximum:ref(420),dragging:ref(false),start:noop,move:noop,stop:noop,key:noop,reset:noop,
      details:{dragging:ref(false),start:noop,move:noop,stop:noop,key:noop,reset:noop}})},'style'))!;
  try {assert.equal(state.style.value['--history-details-width'],'222px');detailsWidth.value=342;assert.equal(state.style.value['--history-details-width'],'342px');}
  finally{scope.stop();}
});


test('details disappearing while captured stops the actual right resizer before SFC removal',async()=>{
  const hasDetails=ref(true),scope=effectScope();
  const f=scope.run(()=>actualLayoutHandlers(()=>hasDetails.value))!;
  const capture=new Set<number>(),released:number[]=[],element={setPointerCapture:(id:number)=>capture.add(id),hasPointerCapture:(id:number)=>capture.has(id),releasePointerCapture:(id:number)=>{capture.delete(id);released.push(id);}};
  try {
    f.state.details.start({button:0,pointerId:31,clientX:900,currentTarget:element,preventDefault(){}});
    f.state.details.move({pointerId:31,clientX:860});
    assert.equal(f.state.details.dragging.value,true);assert.equal(capture.has(31),true);assert.equal(f.state.detailsWidth.value,262);
    await nextTick();assert.equal(f.state.details.dragging.value,true,'an unchanged visible rail keeps the current drag');
    hasDetails.value=false;await nextTick();
    assert.equal(f.state.details.dragging.value,false);assert.equal(capture.size,0);assert.deepEqual(released,[31]);
    assert.equal(f.storage.get(HISTORY_DETAILS_WIDTH_KEY),'262');assert.equal(f.state.detailsWidth.value,0);
    hasDetails.value=true;await nextTick();assert.equal(f.state.detailsWidth.value,262);assert.equal(f.state.details.dragging.value,false);
    f.state.details.start({button:0,pointerId:32,clientX:900,currentTarget:element,preventDefault(){}});
    f.window.innerWidth=900;f.listeners.get('resize')!();assert.equal(capture.size,0);assert.equal(f.state.details.dragging.value,false);
    f.window.innerWidth=1440;f.listeners.get('resize')!();f.state.details.start({button:0,pointerId:33,clientX:900,currentTarget:element,preventDefault(){}});
    f.deactivate();assert.equal(capture.size,0);assert.equal(f.state.details.dragging.value,false);
  }finally{f.unmount();scope.stop();}
});

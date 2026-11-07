import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as Vue from 'vue';
import {computed,ref,createSSRApp,type ComputedRef} from 'vue';
import {renderToString} from '@vue/server-renderer';
import {parse,compileTemplate} from '@vue/compiler-sfc';
import {loadRolePlanPage} from '../src/roleKnowledgeClient';
const file=new URL('../../src/plugins/io.rabiroute.manager.persona/web/pages/RoleKnowledgePage.vue',import.meta.url);
const page=fs.readFileSync(file,'utf8');
const parsed=parse(page,{filename:file.pathname});assert.deepEqual(parsed.errors,[]);
const script=ts.createSourceFile('knowledge.ts',parsed.descriptor.scriptSetup!.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const compile=(s:string)=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function declaration(name:string){return script.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(script)===name))?.getText(script)??'';}
function method(name:string){return script.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)?.getText(script)??'';}
function response(extra:Record<string,unknown>={}){return {items:[{id:'healthy'}],counts:{total:1},total:1,nextCursor:'next',facets:{statuses:[],tags:[]},...extra};}
function actualHandlers(){
  const state={computed,AbortController,requestVersion:1,roleId:ref('fixture-role'),focusedPlanId:ref(''),isEnglish:ref(false),
    showsPlanList:ref(true),showsMemoryList:ref(false),loading:ref(false),loadingMorePlans:ref(false),memoryLoading:ref(false),planListAbort:null,
    planCollectionPartial:ref(false),planCollectionDiagnostics:ref<Array<Record<string,unknown>>>([]),planError:ref(''),planPageError:ref(''),planListReady:ref(false),planCatalogInitializing:ref(false),planEventReset:ref(false),
    knowledgeCountsError:ref(''),knowledgeListLoading:ref(false),memoryError:ref(''),plans:ref<unknown[]>([]),visiblePlansForView:ref<unknown[]>([]),visibleMemoryForView:ref([]),totalMemoryForView:ref(0),
    planListResultTotal:ref(0),planPageCounts:ref({}),planListStatusOptions:ref([]),planListTagOptions:ref([]),planNextCursor:ref(''),reply:response() as unknown,requests:0,
    planEventRefresh:{running:false,idle(){}},knowledgePageWorkAllowed:()=>true,currentPlanPageFilter:()=>({}),
    applyPlanSnapshots:(items:unknown[],replace:boolean)=>{state.plans.value=replace?items:[...state.plans.value,...items];state.visiblePlansForView.value=state.plans.value;},
    loadRolePlanPage:async()=>{state.requests++;if(state.reply instanceof Error)throw state.reply;return state.reply;},userFacingError:(e:Error)=>e.message,
    scheduleProgressiveSentinelRefresh(){},refreshExpandedPlanAgentStatuses(){},
    cancelPlanListWork(){},planRenderStart:ref(0),planRenderLimit:ref(8),memoryRenderLimit:ref(24),schedulePlanDetailObserverRefresh(){},
    activeView:ref('plans'),query:ref(''),planListSortMode:ref('status'),planListHiddenStatuses:ref([]),planListSelectedTags:ref([]),
    feedbackRoleEpoch:0,feedbackFocusOpen:ref(false),approvalDrafts:{},questionDrafts:{}
  };
  const context=vm.createContext(state);
  vm.runInContext(compile(['resetPlanCollectionDiagnostics','applyPlanCollectionDiagnostics','refreshPlanKnowledge','loadMorePlans'].map(method).join('\n')+'\n'+['knowledgeListWarning','knowledgeListStatus'].map(declaration).join('\n')),context);
  const status=vm.runInContext('({knowledgeListWarning,knowledgeListStatus})',context) as {knowledgeListWarning:ComputedRef<boolean>;knowledgeListStatus:ComputedRef<string>};
  return {state,context,status,run:(name:string,args='')=>vm.runInContext(`${name}(${args})`,context) as Promise<void>};
}
const diagnostic={code:'duplicate_plan_identity',planId:'damaged',files:['plans/active/damaged/plan.json','plans/archive/damaged/plan.json'],message:'Unchanged raw files'};

test('actual first-page handler keeps partial rows ready and exposes a nonblocking warning',async()=>{
  const f=actualHandlers();f.state.reply=response({partial:true,diagnostics:[diagnostic]});await f.run('refreshPlanKnowledge','"fixture-role",1');
  assert.equal(f.state.planListReady.value,true);assert.equal(f.state.planError.value,'');assert.equal(f.state.planNextCursor.value,'next');
  assert.equal(f.status.knowledgeListWarning.value,true,'partial success must not be presented as a complete healthy catalog');
  assert.match(f.status.knowledgeListStatus.value,/可读计划/);
  f.state.reply=response({items:[{id:'second'}],nextCursor:''});await f.run('loadMorePlans');
  assert.equal(f.state.requests,2);assert.equal(f.state.plans.value.length,2);assert.equal(f.state.planCollectionPartial.value,true);assert.equal(f.state.planPageError.value,'');
});

test('actual warning template locates the affected record and all-bad partial cannot show normal empty success',async()=>{
  const f=actualHandlers();f.state.reply=response({items:[],total:0,nextCursor:'',partial:true,diagnostics:[{...diagnostic,planId:'<unsafe>'}]});await f.run('refreshPlanKnowledge','"fixture-role",1');
  const start=page.indexOf('<v-alert v-if="roleId && showsPlanList && !focusedPlanId && planCollectionPartial"');assert.ok(start>=0);
  const fragment=page.slice(start,page.indexOf('</v-alert>',start)+10);
  const compiled=compileTemplate({source:fragment,filename:file.pathname,id:'partial-warning'});assert.deepEqual(compiled.errors,[]);
  const exports:{render?:Vue.RenderFunction}={};new Function('require','exports',compile(compiled.code))((id:string)=>{assert.equal(id,'vue');return Vue;},exports);
  const app=createSSRApp({setup:()=>f.state,render:exports.render});app.config.warnHandler=()=>{};
  const html=await renderToString(app);assert.match(html,/数量仅包含可读记录/);assert.match(html,/duplicate_plan_identity/);assert.match(html,/plans\/archive\/damaged\/plan.json/);assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/<unsafe>/);
  const empty=page.match(/v-if="([^"]+)" class="knowledge-empty"/);assert.ok(empty);
  Object.assign(f.state,{hasMorePlans:false,visiblePlansForView:[],planListReady:true,loading:false,loadingMorePlans:false,planError:'',planPageError:'',planCollectionPartial:true});
  assert.equal(vm.runInContext(empty[1]!,f.context),false);Object.assign(f.state,{planCollectionPartial:false});assert.equal(vm.runInContext(empty[1]!,f.context),true);
});

test('actual role and query watchers discard old diagnostics while replacement and append keep query ownership',async()=>{
  const f=actualHandlers();const watchStatements=script.statements.filter(node=>ts.isExpressionStatement(node)&&node.getText(script).startsWith('watch('));
  for(const marker of ['feedbackRoleEpoch++','planListSortMode,']){
    const source=watchStatements.find(node=>node.getText(script).includes(marker));assert.ok(source);
    const callbacks:Array<()=>void>=[];Object.assign(f.state,{watch:(_source:unknown,cb:()=>void)=>callbacks.push(cb)});
    await f.run('applyPlanCollectionDiagnostics',JSON.stringify({partial:true,diagnostics:[diagnostic]}));assert.equal(f.state.planCollectionPartial.value,true);
    vm.runInContext(compile(source.getText(script)),f.context);assert.equal(callbacks.length,1);callbacks[0]!();assert.equal(f.state.planCollectionPartial.value,false);assert.equal(f.state.planCollectionDiagnostics.value.length,0);
  }
  await f.run('applyPlanCollectionDiagnostics',JSON.stringify({partial:true,diagnostics:[diagnostic]}));await f.run('applyPlanCollectionDiagnostics','{},true');assert.equal(f.state.planCollectionPartial.value,true);
  await f.run('applyPlanCollectionDiagnostics','{}');assert.equal(f.state.planCollectionPartial.value,false);
});

test('actual client preserves optional partial DTO fields with the original cursor and response',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:response({items:[],partial:true,diagnostics:[diagnostic]})}),{status:200});
  try {const result=await loadRolePlanPage('fixture-role');assert.equal(result.partial,true);assert.deepEqual(result.diagnostics,[diagnostic]);assert.equal(result.nextCursor,'next');assert.equal(result.total,1);}
  finally {globalThis.fetch=previous;}
});

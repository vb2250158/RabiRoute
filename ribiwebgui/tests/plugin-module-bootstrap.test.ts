import fs from "node:fs";
import * as Vue from "vue";
import { computed, createSSRApp, reactive, ref, type ComputedRef, type Ref, type RenderFunction } from "vue";
import { renderToString } from "@vue/server-renderer";
import { parse, compileTemplate } from "@vue/compiler-sfc";
import ts from "typescript";
import type { WebPluginCatalogStatus } from "../src/pluginContributions";
import assert from "node:assert/strict";
import test from "node:test";
import { refreshWebPluginModulesSafely, webPluginPageLoading } from "../src/pluginModuleBootstrap";

test("Web plugin bootstrap waits for the initial module graph", async () => {
  const calls: string[] = [];
  assert.equal(webPluginPageLoading("idle"), true);
  assert.equal(webPluginPageLoading("ready"), true, "catalog completion alone does not finish the initial module graph");
  const loaded = await refreshWebPluginModulesSafely(async () => { calls.push("refresh"); });
  assert.equal(loaded, true);
  assert.deepEqual(calls, ["refresh"]);
  assert.equal(webPluginPageLoading("ready"), false);
});

test("a failed optional Web Bundle leaves the fixed WebGUI host available", async () => {
  const failures: Array<{ message: string; error: unknown }> = [];
  const error = new Error("broken bundle");
  const loaded = await refreshWebPluginModulesSafely(
    async () => { throw error; },
    (message, cause) => failures.push({ message, error: cause })
  );
  assert.equal(loaded, false);
  assert.deepEqual(failures, [{
    message: "Web plugin module refresh failed; the fixed WebGUI host remains available.",
    error
  }]);
});

function actualRecovery(status: Ref<WebPluginCatalogStatus>) {
  const route=reactive({name:"plugin-recovery",meta:{title:"插件恢复"},query:{from:"/roles"}});
  const moved:string[]=[];
  const router={resolve:(path:string)=>({fullPath:path,meta:{pluginRouteId:"route.roles"}}),replace:async(path:string)=>{moved.push(path);route.name="roles";route.meta.title="角色配置";}};
  const catalog={status,pages:ref({mode:"catalog",pages:[]}),refresh:async()=>{status.value="ready";}};
  const file=new URL("../src/pages/PluginCatalogRecoveryPage.vue",import.meta.url);
  const {descriptor,errors}=parse(fs.readFileSync(file,"utf8"));assert.deepEqual(errors,[]);assert.ok(descriptor.scriptSetup&&descriptor.template);
  const source=ts.createSourceFile("recovery.ts",descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const body=source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(source)).join("\n");
  const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const state=new Function("computed","ref","useRoute","useRouter","pluginCatalogStore","isWebPageRouteActive","webPluginPageLoading","useI18n",compile(body)+";return {loading,refreshing,requestedPath,retry,t};")(
    computed,ref,()=>route,()=>router,catalog,()=>status.value==="ready",webPluginPageLoading,()=>({t:(text:string)=>text})
  ) as {loading:ComputedRef<boolean>;refreshing:Ref<boolean>;requestedPath:ComputedRef<string>;retry():Promise<void>;t(text:string):string};
  const template=compileTemplate({source:descriptor.template.content,filename:file.pathname,id:"recovery-test"});assert.deepEqual(template.errors,[]);
  const exports:{render?:RenderFunction}={};new Function("require","exports",compile(template.code))((name:string)=>{assert.equal(name,"vue");return Vue;},exports);assert.ok(exports.render);
  const render=exports.render;
  const appFile=new URL("../src/App.vue",import.meta.url),appSetup=parse(fs.readFileSync(appFile,"utf8")).descriptor.scriptSetup!;
  const appSource=ts.createSourceFile("app.ts",appSetup.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const title=appSource.statements.find((node):node is ts.VariableStatement=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(appSource)==="pageTitle"));assert.ok(title);
  const pageTitle=new Function("computed","t","route","pluginCatalogStore","PLUGIN_RECOVERY_ROUTE_NAME","webPluginPageLoading",compile(title.getText(appSource))+";return pageTitle;")(
    computed,(text:string)=>text,route,catalog,"plugin-recovery",webPluginPageLoading
  ) as ComputedRef<string>;
  return {state,route,moved,pageTitle,html:async()=>{const app=createSSRApp({setup:()=>state,render});app.config.warnHandler=()=>{};return renderToString(app);}};
}

test("actual recovery and App title show loading through catalog and module phases before normal navigation",async()=>{
  const status=ref<WebPluginCatalogStatus>("idle"),view=actualRecovery(status);
  for(const phase of ["idle","loading"] as const){status.value=phase;assert.equal(view.pageTitle.value,"页面已切换，正在加载内容");const html=await view.html();assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/插件页面暂不可用|没有读取到可用的插件目录|重新读取插件目录/);}
  let finish!:()=>void;
  const graph=refreshWebPluginModulesSafely(()=>new Promise<void>(resolve=>{finish=resolve;}));status.value="ready";
  assert.equal(view.state.loading.value,true);assert.doesNotMatch(await view.html(),/插件页面暂不可用|没有读取到可用的插件目录/);
  finish();assert.equal(await graph,true);
  await view.state.retry();assert.deepEqual(view.moved,["/roles"]);assert.equal(view.pageTitle.value,"角色配置");assert.equal(view.state.refreshing.value,false);
});

test("a completed catalog failure keeps the real recovery controls while unrelated pages keep their title",async()=>{
  let finish!:()=>void;const graph=refreshWebPluginModulesSafely(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const status=ref<WebPluginCatalogStatus>("unavailable"),view=actualRecovery(status);
  try{assert.equal(view.state.loading.value,false);assert.equal(view.pageTitle.value,"插件恢复");const html=await view.html();assert.match(html,/插件页面暂不可用/);assert.match(html,/重新读取插件目录/);assert.doesNotMatch(html,/aria-busy="true"/);
    view.route.name="healthy-page";view.route.meta.title="消息记录";assert.equal(view.pageTitle.value,"消息记录");
  }finally{finish();await graph;}
});

test("a completed module failure exposes recovery rather than an endless startup spinner",async()=>{
  let fail!:(error:Error)=>void;const failures:unknown[]=[];
  const graph=refreshWebPluginModulesSafely(()=>new Promise<void>((_resolve,reject)=>{fail=reject;}),(_message,error)=>failures.push(error));
  const view=actualRecovery(ref<WebPluginCatalogStatus>("ready"));assert.equal(view.state.loading.value,true);
  fail(new Error("fixture module unavailable"));assert.equal(await graph,false);assert.equal(failures.length,1);assert.equal(view.state.loading.value,false);
  const html=await view.html();assert.match(html,/插件页面暂不可用/);assert.match(html,/重新读取插件目录/);assert.doesNotMatch(html,/aria-busy="true"/);
});

test("one completed refresh does not hide another real module refresh still in flight",async()=>{
  let first!:()=>void,last!:()=>void;
  const a=refreshWebPluginModulesSafely(()=>new Promise<void>(resolve=>{first=resolve;}));
  const b=refreshWebPluginModulesSafely(()=>new Promise<void>(resolve=>{last=resolve;}));
  first();await a;assert.equal(webPluginPageLoading("ready"),true);
  last();await b;assert.equal(webPluginPageLoading("ready"),false);
});

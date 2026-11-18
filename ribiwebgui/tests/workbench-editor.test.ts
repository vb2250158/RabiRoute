import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {linkedText,changeConfig,configFields,connectGraph,stageLayout,groupBounds,mergePage,visibleList,type FlowGraph,type WorkbenchDefinition} from "../../src/plugins/io.rabiroute.manager.video/web/pages/workbenchEditor";
const definition=JSON.parse(fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.video/workbench-definition.json",import.meta.url),"utf8")) as WorkbenchDefinition;
const graph=():FlowGraph=>({nodes:["a","b","c"].map(id=>({id,kind:"command",config:{},layout:{x:0,y:0}})),edges:[{id:"ab",from:"a",to:"b",fromPort:"control",toPort:"control",condition:"success"}],groups:[{id:"prepare",name:"准备",nodeIds:["a","b"]},{id:"publish",name:"制作",nodeIds:["c"]}]});
test("port connections use the same DAG contract including data dependencies and reject duplicate wires",()=>{
  const original=graph(),edge={id:"bc",from:"b",to:"c",fromPort:"control",toPort:"control",condition:"success"};
  assert.equal(connectGraph(original,definition,edge),edge);assert.equal(original.edges.length,1);
  assert.throws(()=>connectGraph(original,definition,{...edge,id:"duplicate",from:"a",to:"b"}),/已经连接/);
  assert.throws(()=>connectGraph(original,definition,{...edge,from:"b",to:"a"}),/循环/);
  assert.throws(()=>connectGraph(original,definition,{...edge,fromPort:"missing"}),/端口/);
  original.nodes[0].inputs=[{producerNodeId:"c",artifactKey:"result"}];
  assert.throws(()=>connectGraph(original,definition,edge),/循环/);
});
test("stage layout retains graph semantics and positions every node once, including ungrouped nodes",()=>{
  const original=graph(),before=structuredClone(original);original.groups[1].nodeIds.push("a");original.nodes.push({id:"ungrouped",kind:"human",config:{}});
  const input=structuredClone(original),positions=stageLayout(original,definition);
  assert.deepEqual(original,input);assert.equal(Object.keys(positions).length,4);assert.ok(positions.a.x<positions.b.x);assert.ok(positions.c.y>positions.a.y);assert.ok(positions.ungrouped.y>positions.c.y);
  const bounds=groupBounds(before.groups[0],positions)!;assert.ok(bounds.x<positions.a.x);assert.ok(bounds.width>=positions.b.x-positions.a.x+320);assert.equal(groupBounds({id:"empty",nodeIds:[]},positions),undefined);
});
test("basic config fields retain unknown values, spaces in argv and nested provider extensions",()=>{
  const original={argv:["old"],target:{threadId:"original",providerExtension:42},future:{keep:true}};
  const field=configFields.command.find(field=>field.path==="argv")!;
  const changed=changeConfig(original,field,"script.py\npath with spaces\n");
  assert.deepEqual(changed.argv,["script.py","path with spaces",""]);assert.deepEqual(original.argv,["old"]);
  const target=changeConfig(changed,{path:"target.threadId",label:"目标对话"},"new");assert.equal(target.target.providerExtension,42);assert.deepEqual(target.future,{keep:true});
  assert.equal(changeConfig(target,{path:"timeoutMs",label:"超时",type:"number"},"1200").timeoutMs,1200);
  assert.throws(()=>changeConfig(target,{path:"timeoutMs",label:"超时",type:"number"},"bad"),/需要数字/);
});
test("large canvas lists retain a bounded summary window and render only visible rows",()=>{
  let current:{id:string}[]=[],removed=0;
  for(let page=0;page<100;page++){const result=mergePage(current,Array.from({length:50},(_,index)=>({id:String(page*50+index)})));current=result.rows;removed+=result.removed;}
  assert.equal(current.length,300);assert.equal(removed,4700);assert.equal(current[0].id,"4700");assert.equal(current.at(-1)!.id,"4999");
  for(const scroll of [0,800,23000,100000]){const range=visibleList(current.length,scroll,480);assert.ok(range.end-range.start<=13);assert.equal(range.top+(range.end-range.start)*80+range.bottom,300*80);}
  assert.deepEqual(visibleList(1,100000,480),{start:0,end:1,top:0,bottom:0});
});

test("linked text contributes multiple live sources without overwriting the destination prompt", () => {
  const cards = [{ id: "subject", kind: "text", text: "大肥鱼" }, { id: "costume", kind: "text", text: "雨衣" }, { id: "video", kind: "video", text: "原来的提示词" }];
  const links = [{ from: "subject", to: "video" }, { from: "costume", to: "video" }];
  assert.equal(linkedText(cards, links, "video"), "大肥鱼\n\n雨衣");
  cards[1].text = "红色雨衣";
  assert.equal(linkedText(cards, links, "video"), "大肥鱼\n\n红色雨衣");
  assert.equal(cards[2].text, "原来的提示词");
});

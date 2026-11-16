import test from "node:test";
import assert from "node:assert/strict";
import definition from "./workbench-definition.json" with {type:"json"};
import {importWorkbench,exportLinear} from "./workbenchImport.mjs";
test("39-node source produces 38 ordered edges and an explicit conversion report",()=>{
  const source={title:"示例工作流",nodes:Array.from({length:39},(_,index)=>({id:`step-${index}`,kind:index<3?"agent":"cli",stage:index<15?"collection":"production",gate:true,expect:index%2?[`outputs/result-${index}.txt`]:[],command:"unresolved source command"}))};
  const {canvas,report}=importWorkbench(source,definition);canvas.importReport=report;
  assert.equal(report.nodeCount,39);assert.equal(report.edgeCount,38);assert.equal(report.stages.collection,15);
  assert.equal(canvas.graph.nodes.filter(node=>node.kind==="agent").length,3);
  assert.ok(report.gaps.some(row=>row.code==="required_artifact_contract_missing"));
  assert.deepEqual(exportLinear(canvas,source,definition),source);
  canvas.graph.edges.pop();assert.throws(()=>exportLinear(canvas,source,definition),/无损/);
});
test("complete graph import preserves extensions and remaps internal IDs",()=>{
  const source={version:2,name:"图",variables:[],extension:{retained:true},graph:{nodes:[{id:"a",kind:"command",config:{toolKey:"node",argv:[]}}],edges:[],groups:[]}};
  const {canvas}=importWorkbench(source,definition);assert.notEqual(canvas.graph.nodes[0].id,"a");assert.deepEqual(canvas.extension,source.extension);
  assert.throws(()=>importWorkbench({nodes:[{id:"a",kind:"unknown"}]},definition),/不支持/);
});

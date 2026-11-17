import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,validateVisualCanvas,withVisualCanvasProtocol} from '../src/visual-canvas.js';
import {createAgentProtocol} from '../src/decision-protocol.js';
const document={title:'Price trend',nodes:[{kind:'chart',chartType:'line',x:0,y:0,width:620,height:500,title:'Price / CNY',labels:['Mon','Tue','Wed'],series:[{name:'GPU',values:[3000,null,2800]}]},{kind:'chart',chartType:'pie',x:620,y:0,width:340,height:400,labels:['A','B'],series:[{name:'Share',values:[30,70]}]}]};
test('one canvas replaces atomically, temporary input expiry and persistent state are shared across hosts',()=>{
 const saved=[],canvas=createVisualCanvas({onSave:value=>saved.push(value)}),epoch=canvas.beginInput();
 canvas.show(document,{inputEpoch:epoch,responseId:'reply-1'});assert.equal(canvas.snapshot().visible,true);
 canvas.beginInput();assert.equal(canvas.snapshot().visible,false);assert.equal(canvas.snapshot().document.title,'Price trend');
 assert.throws(()=>canvas.show(document,{inputEpoch:epoch}),/STALE_TURN/);
 assert.throws(()=>canvas.close({inputEpoch:epoch}),/STALE_TURN/);
 canvas.show({...document,title:'Updated'},{persistent:true});canvas.beginInput();assert.equal(canvas.snapshot().visible,true);
 const restored=createVisualCanvas({initial:canvas.snapshot()});assert.equal(restored.snapshot().document.title,'Updated');
 const protocol=withVisualCanvasProtocol(createAgentProtocol(),canvas),input=JSON.parse(protocol.input('request',{text:'continue'})[0].content);
 assert.equal(input.visualCanvas.visible,true);assert.equal(input.visualCanvas.document.title,'Updated');
 canvas.close();assert.equal(canvas.snapshot().visible,false);assert.equal(saved.at(-1).visible,false);
});
test('invalid scenes fail without replacing an existing surface or executing markup',()=>{
 const canvas=createVisualCanvas();canvas.show(document);const before=canvas.snapshot();
 for(const value of [{...document,html:'<script />'},{...document,nodes:[{...document.nodes[0],x:900}]},{...document,nodes:[{...document.nodes[1],series:[{name:'Share',values:[-1,20]}]}]}])assert.throws(()=>canvas.show(value),/CANVAS_INVALID/);
 assert.deepEqual(canvas.snapshot(),before);
 assert.throws(()=>validateVisualCanvas({...document,sources:[{label:'bad',url:'javascript:alert(1)'}]}),/CANVAS_INVALID/);
 const tools=createVisualCanvasTools(canvas);assert.equal(tools.executeTool({arguments:{action:'inspect'}}).canvas.visible,true);
});
test('the shared renderer paints charts and primitives with the AIUI documented 2D subset',()=>{
 const calls=[];const ctx=new Proxy({measureText:value=>({width:value.length*14})},{get:(target,key)=>target[key]??((...args)=>calls.push([key,args])),set:(target,key,value)=>{target[key]=value;return true}});
 paintVisualCanvas(ctx,{...document,nodes:[...document.nodes,{kind:'rect',x:20,y:505,width:200,height:35,text:'source'},{kind:'arrow',x:240,y:505,width:200,height:30,text:'flow'}]},{width:480,height:270});
 assert.ok(calls.some(([method])=>method==='arc'));assert.ok(calls.some(([method,args])=>method==='scale'&&args[0]===.5));assert.equal(calls.at(-1)[0],'flush');
 assert.ok(!calls.some(([,args])=>args.some(value=>typeof value==='number'&&!Number.isFinite(value))));
});

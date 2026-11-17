import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,withVisualCanvasProtocol} from '../../../packages/assistant-runtime/src/visual-canvas.js';
const source=fs.readFileSync(new URL('../utils/visual-canvas-page.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export const ','const ');
test('AIUI uses the shared canvas owner, device scope persistence and native Canvas context',()=>{
 const saved=new Map(),draws=[],ctx=new Proxy({measureText:text=>({width:text.length*12})},{get:(target,key)=>target[key]??((...args)=>draws.push([key,args])),set:(target,key,value)=>{target[key]=value;return true}});
 const methods=vm.runInNewContext(source+'\nvisualCanvasPageMethods',{createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,withVisualCanvasProtocol,window:{innerWidth:480,innerHeight:352},wx:{getStorageSync:key=>saved.get(key),setStorageSync:(key,value)=>saved.set(key,structuredClone(value)),createCanvasContext:id=>{assert.equal(id,'assistantVisualCanvas');return ctx}}});
 let scope='persona-a';const page={...methods,pageReady:true,data:{},currentAgentProfileScope:()=>scope,setData(value){Object.assign(this.data,value)}};
 page.beginVisualCanvasInput();page.visualCanvasBackend().executeTool({arguments:{action:'show',persistent:true,document:{title:'Map',nodes:[{kind:'rect',x:0,y:0,width:960,height:540,text:'fixture'}]}}});
 assert.equal(page.data.visualCanvasVisible,true);assert.equal(page.data.visualCanvasWidth/page.data.visualCanvasHeight,16/9);assert.ok(draws.some(([key])=>key==='flush'));
 page.visualCanvasActiveTurnEpoch=page.visualCanvasTurnEpoch;
 page.visualCanvasInputPending=false;page.beginVisualCanvasInput();assert.equal(page.data.visualCanvasVisible,true);
 assert.throws(()=>page.visualCanvasBackend().executeTool({arguments:{action:'close'}}),/STALE_TURN/);
 scope='persona-b';page.paintVisualCanvas();assert.equal(page.data.visualCanvasVisible,false);
 scope='persona-a';page.paintVisualCanvas();assert.equal(page.data.visualCanvasTitle,'Map');page.closeVisualCanvas();assert.equal(page.data.visualCanvasVisible,false);
});

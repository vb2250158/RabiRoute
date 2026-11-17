import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createCanvasPresenter}=createRequire(import.meta.url)('../runtime/canvas-presenter.cjs');
test('desktop canvas follows captions, can undock and dock, hides and releases its window',async()=>{
 const windows=[],events=[];
 class Window{constructor(options){this.bounds={x:0,y:0,width:options.width,height:options.height};this.handlers={};this.webContents={send:(...args)=>events.push(args)};windows.push(this)}on(name,listener){this.handlers[name]=listener}async loadFile(){}setMovable(value){this.movable=value}setBounds(value){this.bounds=value}getBounds(){return this.bounds}showInactive(){this.visible=true}hide(){this.visible=false}isVisible(){return this.visible}close(){this.closed=true}}
 const area={x:0,y:0,width:1600,height:1000},sent=[],presenter=createCanvasPresenter({BrowserWindow:Window,screen:{getPrimaryDisplay:()=>({workArea:area}),getDisplayMatching:()=>({workArea:area})},send:event=>sent.push(event),safeWindow:()=>{}});
 const state={visible:true,revision:1,document:{title:'chart'}};
 await presenter.update(state,{x:300,y:800,width:720,height:150});const window=windows[0];assert.equal(window.visible,true);assert.equal(window.bounds.y,343);assert.equal(window.movable,false);
 presenter.follow({x:400,y:800,width:720,height:150});assert.equal(window.bounds.x,400);
 assert.equal(presenter.action({},'canvas-dock'),false);presenter.action(window.webContents,'canvas-dock');const before={...window.bounds};presenter.follow({x:100,y:800,width:720,height:150});assert.deepEqual(window.bounds,before);assert.equal(window.movable,true);
 presenter.action(window.webContents,'canvas-dock');assert.equal(window.bounds.x,100);
 presenter.action(window.webContents,'canvas-close');assert.equal(window.visible,false);assert.equal(sent.at(-1).action,'canvas-close');
 await presenter.update({visible:false});assert.equal(window.visible,false);presenter.close();assert.equal(window.closed,true);
});

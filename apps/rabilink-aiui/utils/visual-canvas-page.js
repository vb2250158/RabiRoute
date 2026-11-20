import wx from 'wx';
import {createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,withVisualCanvasProtocol} from '../../../packages/assistant-runtime/src/visual-canvas.js';

export const visualCanvasPageMethods={
 ensureVisualCanvas(){
  const scope=String(this.currentAgentProfileScope?.()||'local-aiui');
  if(this.visualCanvasOwner?.scope===scope)return this.visualCanvasOwner;
  const storageKey='rabi-visual-canvas-v1:'+scope;let initial;
  try{initial=wx.getStorageSync(storageKey)}catch{}
  const canvas=createVisualCanvas({initial,onSave:value=>wx.setStorageSync(storageKey,value),onChange:value=>{
   if(this.destroyed)return;
   this.setData({visualCanvasVisible:value.visible,visualCanvasTitle:value.document?.title||'',visualCanvasPersistent:value.persistent});
   this.paintVisualCanvas();
  }});
  const tools=createVisualCanvasTools(canvas,{owner:()=>({inputEpoch:this.visualCanvasActiveTurnEpoch,responseId:'turn-'+this.promptGeneration})});
  this.visualCanvasOwner={scope,canvas,tools};this.visualCanvasTurnEpoch=undefined;this.visualCanvasActiveTurnEpoch=undefined;this.visualCanvasInputPending=false;
  if(this.pageReady)this.paintVisualCanvas();
  return this.visualCanvasOwner;
 },
 paintVisualCanvas(){
  if(!this.pageReady||this.destroyed)return;
  const value=this.ensureVisualCanvas().canvas.snapshot();
  const viewport=globalThis.window;
  const width=Math.max(160,Math.min((viewport?.innerWidth||480)-32,Math.max(90,(viewport?.innerHeight||352)-132)*16/9));
  this.setData({visualCanvasVisible:value.visible,visualCanvasTitle:value.document?.title||'',visualCanvasPersistent:value.persistent,visualCanvasWidth:width,visualCanvasHeight:width*9/16});
  if(!value.visible||typeof wx.createCanvasContext!=='function')return;
  const ctx=wx.createCanvasContext('assistantVisualCanvas');
  if(ctx)paintVisualCanvas(ctx,value.document,{color:'#00ff88',background:'#000000'});
 },
 beginVisualCanvasInput(){const owner=this.ensureVisualCanvas();if(this.visualCanvasInputPending)return;this.visualCanvasInputPending=true;this.visualCanvasTurnEpoch=owner.canvas.beginInput()},
 closeVisualCanvas(){this.ensureVisualCanvas().canvas.close()},
 visualCanvasProtocol(protocol){return withVisualCanvasProtocol(protocol,this.ensureVisualCanvas().canvas)},
 visualCanvasBackend(){return this.ensureVisualCanvas().tools},
};

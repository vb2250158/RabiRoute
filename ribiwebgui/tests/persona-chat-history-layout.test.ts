import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { waitForChatHistoryFrame } from "../src/personaChatHistoryLayout";

test("a paused layout frame is released on abort, hiding, or completion", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const document = Object.assign(new EventTarget(), { hidden: false });
  let callback: FrameRequestCallback | undefined;
  let cancelled = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (next: FrameRequestCallback) => { callback = next; return 7; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { assert.equal(id, 7); cancelled++; callback = undefined; } });
  try {
    for (const outcome of ["abort", "hidden", "frame"] as const) {
      document.hidden = false;
      const controller = new AbortController();
      const result = waitForChatHistoryFrame(controller.signal);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      assert.equal(getEventListeners(document, "visibilitychange").length, 1);
      if (outcome === "abort") controller.abort();
      else if (outcome === "hidden") { document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
      else callback!(0);
      assert.equal(await result, outcome === "frame");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(getEventListeners(document, "visibilitychange").length, 0);
      assert.equal(callback, undefined);
    }
    assert.equal(cancelled, 3);
    document.hidden = true;
    assert.equal(await waitForChatHistoryFrame(new AbortController().signal), false);
    document.hidden = false;
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await waitForChatHistoryFrame(aborted.signal), false);
    assert.equal(cancelled, 3);
  } finally {
    for (const [key, descriptor] of [["document", originalDocument], ["requestAnimationFrame", originalRequest], ["cancelAnimationFrame", originalCancel]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});


test('message reads and scroll adjustments use the containing pane while standalone history uses the document', async () => {
  const {chatHistoryScroller,chatHistoryViewport}=await import('../src/personaChatHistoryLayout');
  const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const documentScroller={scrollTop:40};
  const pane={scrollTop:300,getBoundingClientRect:()=>({top:160,bottom:760})};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{scrollingElement:documentScroller}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{innerHeight:900}});
  try {
    const element={closest:(selector:string)=>{assert.equal(selector,'[data-history-scroll]');return pane;}} as unknown as Element;
    assert.equal(chatHistoryScroller(element),pane);
    assert.deepEqual(chatHistoryViewport(chatHistoryScroller(element)),{top:160,bottom:760});
    assert.equal(chatHistoryScroller(),documentScroller);
    assert.deepEqual(chatHistoryViewport(chatHistoryScroller()),{top:0,bottom:900});
    chatHistoryScroller(element).scrollTop=600;
    assert.equal(pane.scrollTop,600);assert.equal(documentScroller.scrollTop,40);
  } finally {
    for(const [key,descriptor] of [['document',previousDocument],['window',previousWindow]] as const) {
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);
    }
  }
});


test('virtual row resize follows the bottom and preserves an active reading position across hiding and resizing', async () => {
  const {bindChatHistoryScroll}=await import('../src/personaChatHistoryLayout');
  const saved=['ResizeObserver','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  let resized!:()=>void,frame:FrameRequestCallback|undefined,disconnected=false;
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class {constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){disconnected=true;}}});
  Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:(callback:FrameRequestCallback)=>{frame=callback;return 1;}});
  Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:()=>{frame=undefined;}});
  const pane=Object.assign(new EventTarget(),{scrollTop:0,scrollHeight:600,clientHeight:300});
  let top=0;Object.defineProperty(pane,'scrollTop',{get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(value,pane.scrollHeight-pane.clientHeight));}});
  const flush=()=>{const callback=frame;frame=undefined;callback?.(0);};
  let binding:ReturnType<typeof bindChatHistoryScroll>|undefined;
  try {
    binding=bindChatHistoryScroll(pane as unknown as HTMLElement,{} as HTMLElement);
    resized();flush();assert.equal(pane.scrollTop,300);
    pane.scrollHeight=1000;pane.dispatchEvent(new Event('scroll'));resized();flush();assert.equal(pane.scrollTop,700,'late virtual measurements retain the bottom');
    pane.dispatchEvent(new Event('wheel'));pane.scrollTop=200;pane.dispatchEvent(new Event('scroll'));
    pane.scrollHeight=1200;resized();flush();assert.equal(pane.scrollTop,200,'a reader browsing older messages stays in place');
    pane.scrollTop=900;pane.dispatchEvent(new Event('scroll'));
    pane.clientHeight=0;resized();flush();assert.equal(pane.scrollTop,900);
    pane.clientHeight=300;pane.scrollHeight=1600;resized();flush();assert.equal(pane.scrollTop,1300,'restoring a hidden pane retains bottom-following');
    binding.restorePosition(300);pane.scrollHeight=2000;pane.dispatchEvent(new Event('scroll'));resized();flush();
    assert.equal(pane.scrollTop,300,'an explicitly restored reading position remains anchored');
    for(const event of ['wheel','touchstart','pointerdown','keydown']) {
      binding.restorePosition(pane.scrollHeight-pane.clientHeight);
      pane.dispatchEvent(new Event(event));pane.dispatchEvent(new Event('scroll'));pane.scrollTop-=8;pane.dispatchEvent(new Event('scroll'));
      pane.scrollTop=200;pane.dispatchEvent(new Event('scroll'));
      pane.scrollHeight+=100;resized();flush();assert.equal(pane.scrollTop,200,event+' preserves a reader scrolling up');
    }
    binding.dispose();assert.equal(disconnected,true);assert.equal(getEventListeners(pane,'scroll').length,0);
    assert.equal(getEventListeners(pane,'wheel').length,0);
  } finally {
    binding?.dispose();for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});

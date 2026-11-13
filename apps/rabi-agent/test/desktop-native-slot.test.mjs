import test from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { DesktopNativeSlot } from "../lib/desktop-native-slot.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const clients = [];
  const slot = new DesktopNativeSlot({ initial: { version: "old" }, resolve: async ref => ({ version: ref }),
    create: (release, eventSink) => {
      const native = { release, eventSink, calls: [], closed: false,
        async request(action) { this.calls.push(action); return action === "capabilities" ? { protocolVersion: release.version === "bad-abi" ? 1 : 2 } : release.version; },
        async setPresentationTheme(theme) { this.theme = theme; },
        async close() { if (this.barrier) await this.barrier; this.closed = true; }
      }; Object.setPrototypeOf(native, new EventEmitter()); native.eventSink = native.emit.bind(native); clients.push(native); return native;
    }, retire: async native => { await native.close(); }, ...options });
  return { slot, clients };
}

test("prepare and candidate discard preserve the current desktop owner", async () => {
  const {slot,clients} = fixture();
  await slot.setPresentationTheme({theme:"dark"});
  const candidate = await slot.prepare("new");
  assert.equal(await slot.request("screen.capture"), "old");
  assert.deepEqual(clients[1].calls, ["capabilities"]);
  assert.deepEqual(clients[1].theme, {theme:"dark"});
  await slot.discard(candidate);
  assert.equal(clients[1].closed,true);assert.equal(clients[0].closed,false);
  await slot.close();
});
test("adoption waits for the original worker close and changes only this slot revision", async () => {
  const {slot,clients} = fixture();const barrier=deferred();clients[0].barrier=barrier.promise;
  const candidate=await slot.prepare("new");const adopting=slot.activate(candidate,0);
  assert.equal(slot.status().release.version,"old");
  await assert.rejects(slot.request("screen.capture"), {code:"COMPUTER_DESKTOP_UPDATING"});
  barrier.resolve();await adopting;
  assert.equal(clients[0].closed,true);assert.equal(slot.status().revision,1);
  assert.equal(await slot.request("screen.capture"),"new");
  await assert.rejects(slot.activate(candidate,0),{code:"COMPUTER_DESKTOP_REVISION_CONFLICT"});
  await slot.close();
});
test("bad ABI candidate joins its own close before reporting failure without retiring current", async () => {
  const {slot,clients}=fixture();await assert.rejects(slot.prepare("bad-abi"),{code:"COMPUTER_NATIVE_ABI_UNSUPPORTED"});
  assert.equal(clients[1].closed,true);assert.equal(clients[0].closed,false);
  assert.equal(await slot.request("screen.capture"),"old");await slot.close();
});
test("unconfirmed original retirement preserves its owner and cleans only candidate", async () => {
  const failure=new Error("original handle not signaled");const {slot,clients}=fixture({retire:async()=>{throw failure;}});
  const candidate=await slot.prepare("new");await assert.rejects(slot.activate(candidate,0),failure);
  assert.equal(slot.owner.native,clients[0]);assert.equal(slot.status().revision,0);
  assert.equal(slot.status().state,"unconfirmed");assert.equal(clients[1].closed,true);await slot.close();
});
test("retired worker events cannot mutate the replacement owner", async () => {
  const {slot,clients}=fixture();const events=[];slot.on("tracking",event=>events.push(event));
  clients[0].eventSink("tracking","before");const candidate=await slot.prepare("new");await slot.activate(candidate,0);
  clients[0].eventSink("tracking","late");clients[1].eventSink("tracking","after");
  assert.deepEqual(events,["before","after"]);await slot.close();
});
test("shutdown joins active and unselected candidate original close promises", async () => {
  const {slot,clients}=fixture();await slot.prepare("new");const barrier=deferred();clients[1].barrier=barrier.promise;
  let ended=false;const closing=slot.close().then(()=>{ended=true;});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false);barrier.resolve();await closing;assert.equal(clients.every(c=>c.closed),true);
});

test("candidate exit before adoption never retires the current worker", async()=>{
  const {slot,clients}=fixture();const prepared=await slot.prepare("new");clients[1].child=null;
  await assert.rejects(slot.activate(prepared,0),{code:"COMPUTER_DESKTOP_CANDIDATE_EXITED"});
  assert.equal(clients[0].closed,false);assert.equal(clients[1].closed,true);await slot.close();
});
test("candidate lost during old close restores a new original worker after candidate exit", async()=>{
  let clients;const f=fixture({retire:async native=>{await native.close();clients[1].child=null;}});clients=f.clients;
  const prepared=await f.slot.prepare("new");clients[1].child={};
  await assert.rejects(f.slot.activate(prepared,0),{code:"COMPUTER_DESKTOP_CANDIDATE_EXITED"});
  assert.equal(clients[0].closed,true);assert.equal(clients[1].closed,true);assert.equal(clients.length,3);
  assert.equal(f.slot.owner.native,clients[2]);assert.equal(await f.slot.request("screen.capture"),"old");
  assert.equal(f.slot.status().revision,0);assert.equal(f.slot.status().state,"ready");await f.slot.close();
});

test("close joins an entered resolver and no worker can start after the slot closed", async()=>{
  const resolving=deferred();const {slot,clients}=fixture({resolve:()=>resolving.promise});
  const preparation=slot.prepare("new");let closed=false;const closing=slot.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(clients.length,1);
  resolving.resolve({version:"new"});await assert.rejects(preparation,{code:"COMPUTER_STOPPED"});await closing;
  assert.equal(closed,true);assert.equal(clients.length,1);assert.equal(clients[0].closed,true);
});

test("stored selection restores lazily and successful adoption commits the original slot revision",async()=>{
  let saved={revision:4,reference:'stored-old'};let committed=0;
  const {slot}=fixture({restore:async()=>saved,commit:async(release,expected)=>{assert.equal(expected,4);saved={revision:5,reference:release.version};committed++;return {revision:5};}});
  assert.equal(slot.status().state,'initializing');await slot.ready();
  assert.equal(slot.status().revision,4);assert.equal(await slot.request('screen.capture'),'stored-old');
  const candidate=await slot.prepare('stored-new');await slot.activate(candidate,4);
  assert.equal(committed,1);assert.equal(slot.status().revision,5);await slot.close();
  const reopened=fixture({restore:async()=>saved}).slot;await reopened.ready();
  assert.equal(reopened.status().revision,5);assert.equal(await reopened.request('screen.capture'),'stored-new');await reopened.close();
});
test("malformed selection is a desktop-local failure and synchronous resolver error keeps its identity",async()=>{
  const error=Object.assign(new Error('bad desktop selection'),{code:'COMPUTER_DESKTOP_SELECTION_INVALID'});
  const {slot,clients}=fixture({restore:()=>{throw error;}});
  await assert.rejects(slot.ready(),value=>value===error);assert.equal(slot.status().state,'unconfirmed');
  assert.equal(clients.length,1);assert.equal(clients[0].calls.length,0);await slot.close();
});

test("shutdown during restoration of the initial owner cannot construct a replacement",async()=>{
  const barrier=deferred();const {slot,clients}=fixture({restore:async()=>({revision:1,reference:'stored-old'})});
  clients[0].barrier=barrier.promise;const restoring=slot.ready();await new Promise(resolve=>setImmediate(resolve));
  const closing=slot.close();barrier.resolve();await assert.rejects(restoring,{code:'COMPUTER_STOPPED'});await closing;
  assert.equal(clients.length,1);assert.equal(clients[0].closed,true);
});

test("commit acknowledgement loss reads the original selected revision before declaring rollback",async()=>{
  let saved={revision:0};const {slot}=fixture({restore:async()=>saved,resolve:async ref=>({version:ref,digest:ref}),
    commit:async release=>{saved={revision:1,reference:release.digest};throw new Error('acknowledgement lost after original commit');}});
  await slot.ready();const prepared=await slot.prepare('new');await slot.activate(prepared,0);
  assert.equal(slot.status().revision,1);assert.equal(await slot.request('screen.capture'),'new');await slot.close();
});
test("unknown commit readback retains the exact candidate and can reconcile without new native work",async()=>{
  let saved={revision:0},readable=true;const {slot,clients}=fixture({restore:async()=>{if(!readable)throw new Error('selection temporarily unreadable');return saved;},resolve:async ref=>({version:ref,digest:ref}),
    commit:async release=>{saved={revision:1,reference:release.digest};readable=false;throw new Error('acknowledgement lost');}});
  await slot.ready();const prepared=await slot.prepare('new');
  await assert.rejects(slot.activate(prepared,0),{code:'COMPUTER_DESKTOP_SELECTION_UNCONFIRMED'});
  assert.equal(slot.status().state,'unconfirmed');assert.equal(slot.prepared.has(prepared),true);assert.equal(clients[1].closed,false);
  readable=true;slot.commit=async()=>({revision:1});await slot.activate(prepared,0);
  assert.equal(slot.status().revision,1);assert.deepEqual(clients[1].calls,['capabilities']);await slot.close();
});
test("restored selection probes actual worker capabilities rather than the packaged defaults",async()=>{
  const {slot,clients}=fixture({restore:async()=>({revision:2,reference:'no-tracking'})});
  const create=slot.create;slot.create=release=>{const native=create(release);const request=native.request.bind(native);native.request=async action=>action==='capabilities'?{protocolVersion:2,trackingAvailable:false}:request(action);return native;};
  await slot.ready();assert.equal(slot.capabilities.trackingAvailable,false);assert.equal(clients.length,2);await slot.close();
});

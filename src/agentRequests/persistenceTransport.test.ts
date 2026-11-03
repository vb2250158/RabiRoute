import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { serialize } from "node:v8";
import { AgentRequestPersistenceTransport } from "./persistenceTransport.js";

test("metadata fills bounded frames without excess acknowledgement round trips", async t => {
  const { port1, port2 } = new MessageChannel();
  let frames = 0, maximum = 0;
  const original = port1.postMessage.bind(port1);
  t.mock.method(port1, "postMessage", (value: any) => {
    if (value.channel === "agent-request-value") {
      frames++; maximum = Math.max(maximum, serialize(value).byteLength + 4);
    }
    original(value);
  });
  const value = Array.from({ length: 1000 }, (_, id) => ({ id, state: "committed", active: false }));
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const received = new Promise((yes, no) => { resolve = yes; reject = no; });
  const sender = new AgentRequestPersistenceTransport(port1, () => assert.fail("Unexpected reply"), reject);
  const receiver = new AgentRequestPersistenceTransport(port2, (_id, result) => resolve(result), reject);
  try {
    await sender.send("metadata-fixture", value);
    assert.deepEqual(await received, value);
    assert.ok(frames > 1, "Metadata crosses an actual native IPC frame boundary");
    assert.ok(frames < 60, `Small metadata used ${frames} acknowledgement round trips`);
    assert.ok(maximum <= 32768);
  } finally { sender.stop(new Error("Fixture closed")); receiver.stop(new Error("Fixture closed")); port1.close(); port2.close(); }
});

test("complete IPC envelopes stay under 32KiB with Unicode, escapes, empty strings and prototype-like JSON keys", { timeout: 10_000 }, async t => {
  const { port1, port2 } = new MessageChannel();
  let maximum = 0, frames = 0, outstanding = 0, peak = 0;
  const original = port1.postMessage.bind(port1);
  t.mock.method(port1, "postMessage", (value: any) => {
    if (value.channel === "agent-request-value") {
      maximum = Math.max(maximum, serialize(value).byteLength + 4); frames++; outstanding++; peak = Math.max(peak, outstanding);
    }
    original(value);
  });
  port1.on("message", (value: any) => { if (value?.channel === "agent-request-ack") outstanding--; });
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const values = new Map<string, unknown>();
  const received = new Promise((yes, no) => { resolve = yes; reject = no; });
  const sender = new AgentRequestPersistenceTransport(port1, () => assert.fail("Unexpected reverse value"), reject);
  const receiver = new AgentRequestPersistenceTransport(port2, (id, value) => { values.set(id, value); if (values.size === 2) resolve(values); }, reject);
  const value = { text: ('\u0000"\\\n\ud800🔭星海').repeat(30_000), empty: "", optional: undefined,
    nested: [null, true, false, 0, -2.5, { original: "preserved" }] };
  Object.defineProperty(value, "__proto__", { value: { own: "preserved" }, enumerable: true });
  try {
    await Promise.all([sender.send("fixture-message-identifier-000000000000", value), sender.send("fixture-message-identifier-111111111111", value)]);
    await received;
    assert.equal(values.size, 2);
    for (const entry of values.values()) assert.deepEqual(entry, value);
    assert.ok(frames > 10); assert.ok(maximum <= 32_768, `Complete native IPC envelope was ${maximum} bytes`);
    assert.equal(peak, 1); assert.equal(outstanding, 0);
  } finally { sender.stop(new Error("Fixture closed")); receiver.stop(new Error("Fixture closed")); port1.close(); port2.close(); }
});

test('partial native values remain private and sequence mismatch reports the original failure',async()=>{
 let listener: (message: any) => void = () => {}; let received=0; let error: unknown;const port={postMessage(){},on(_event: "message", fn: (message: any) => void){listener=fn},off(){}};
 const receiver=new AgentRequestPersistenceTransport(port,()=>received++,e=>{error=e});
 listener({channel:'agent-request-value',id:'original',sequence:0,bytes:serialize({data:'original'}).subarray(0,3),end:false});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(received,0);
 listener({channel:'agent-request-value',id:'original',sequence:2,bytes:new Uint8Array(),end:true});
 await new Promise(resolve=>setImmediate(resolve));assert.ok(error instanceof Error);assert.match(error.message,/sequence mismatch/);assert.equal(received,0);receiver.stop(Error('closed'));
});
test('stopping an unacknowledged value rejects that send and releases its listener',async()=>{
 let removed=0;const port={postMessage(){},on(){},off(){removed++}};const sender=new AgentRequestPersistenceTransport(port,()=>assert.fail(),()=>assert.fail());
 const original=Error('original close');const send=sender.send('original',{large:'x'.repeat(100000)});await new Promise(resolve=>setImmediate(resolve));sender.stop(original);await assert.rejects(send,e=>e===original);assert.equal(removed,1);
});
test('oversized envelope rejects before exposing a decoded value',async()=>{
 let listener: (message: any) => void = () => {}; let error: unknown;const receiver=new AgentRequestPersistenceTransport({postMessage(){},on(_event: "message", fn: (message: any) => void){listener=fn},off(){}},()=>assert.fail(),e=>{error=e});
 listener({channel:'agent-request-value',id:'original',sequence:0,bytes:new Uint8Array(32768),end:true});await new Promise(resolve=>setImmediate(resolve));assert.ok(error instanceof Error);assert.match(error.message,/wire-byte bound/);receiver.stop(Error('closed'));
});
test('duplicate frame cannot publish a partial original value',async()=>{
 let listener: (message: any) => void = () => {}; let received=0; let error: unknown;const receiver=new AgentRequestPersistenceTransport({postMessage(){},on(_event: "message", fn: (message: any) => void){listener=fn},off(){}},()=>received++,e=>{error=e});
 const first={channel:'agent-request-value',id:'original',sequence:0,bytes:serialize({value:'original'}).subarray(0,3),end:false};listener(first);await new Promise(resolve=>setImmediate(resolve));listener(first);await new Promise(resolve=>setImmediate(resolve));assert.ok(error instanceof Error);assert.match(error.message,/sequence mismatch/);assert.equal(received,0);receiver.stop(Error('closed'));
});
test('end without a complete native value reports failure without publication',async()=>{
 let listener: (message: any) => void = () => {}; let error: unknown;const receiver=new AgentRequestPersistenceTransport({postMessage(){},on(_event: "message", fn: (message: any) => void){listener=fn},off(){}},()=>assert.fail(),e=>{error=e});
 listener({channel:'agent-request-value',id:'original',sequence:0,bytes:new Uint8Array(),end:true});await new Promise(resolve=>setImmediate(resolve));assert(error instanceof Error);receiver.stop(Error('closed'));
});
test('receiver stop before the scheduled acknowledgement publishes neither acknowledgement nor value',async()=>{
 let listener: (message: any) => void = () => {}; let acks=0;const receiver=new AgentRequestPersistenceTransport({postMessage(){acks++},on(_event: "message", fn: (message: any) => void){listener=fn},off(){}},()=>assert.fail(),()=>assert.fail());
 listener({channel:'agent-request-value',id:'original',sequence:0,bytes:serialize({value:'original'}),end:true});receiver.stop(Error('closed'));await new Promise(resolve=>setImmediate(resolve));assert.equal(acks,0);
});

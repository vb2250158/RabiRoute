import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LanAgentTerminals, TerminalDispatchNotSentError } from "./lanAgentTerminals.js";
import { ApiContractError } from "./apiOperationContract.js";

test("invalid output cursors and waits expose same-terminal reads without invoking input", async () => {
  let calls = 0, events = 0;
  const hub = new LanAgentTerminals(async () => { calls++; return {}; });
  const terminalId = randomUUID(); await hub.execute("original-instance", { action: "open", terminalId });
  hub.receive("original-instance", { terminalId, type: "output", data: "private output" });
  const before = calls;
  const check = (field: string, operationId: string) => (error: unknown) => {
    assert.ok(error instanceof ApiContractError); assert.equal(error.status, 400);
    assert.equal(error.field, "query." + field); assert.equal(error.operationId, operationId);
    assert.equal(error.code, field === "after" ? "TERMINAL_OUTPUT_CURSOR_INVALID" : "TERMINAL_WAIT_INVALID");
    assert.ok(error.reason?.includes(`/original-instance/terminals/${terminalId}?after=0&waitMs=0`));
    assert.doesNotMatch(error.reason!, /private output/); return true;
  };
  for (const after of [-1, 1.5, 2, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(hub.read("original-instance", terminalId, after), check("after", "manager.lan-agent.terminals.read"));
    assert.throws(() => hub.subscribe("original-instance", terminalId, after, () => { events++; }), check("after", "manager.lan-agent.terminals.events"));
  }
  for (const wait of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(hub.read("original-instance", terminalId, 0, wait), check("waitMs", "manager.lan-agent.terminals.read"));
  }
  assert.equal(calls, before); assert.equal(events, 0);
  const observed = await hub.read("original-instance", terminalId, 0, 0) as { nextOutputSequence: number };
  assert.equal(observed.nextOutputSequence, 1);
});

test("terminal replay is isolated, bounded and never persists or re-executes input", async () => {
  const calls: unknown[] = [];
  const hub = new LanAgentTerminals(async (instance, body) => { calls.push({ instance, body }); return { ok: true }; });
  const terminalId = randomUUID();
  await hub.execute("node-a", { action: "open", terminalId, shell: "cmd" });
  const received: Array<{ type: string; data?: string }> = [];
  for (let i = 0; i < 100; i++) hub.receive("node-a", { terminalId, type: "output", data: "x".repeat(8192) });
  hub.receive("node-b", { terminalId, type: "output", data: "another node" });
  const unsubscribe = hub.subscribe("node-a", terminalId, 0, event => received.push(event));
  assert.equal(received[0]!.type, "gap");
  assert.ok(received.map(item => item.data || "").join("").length < 262144);
  assert.ok(!received.some(item => item.data === "another node"));
  assert.equal(calls.length, 1);
  unsubscribe();
  const ended: string[] = [];
  hub.subscribe("node-a", terminalId, 100, event => ended.push(event.type));
  hub.disconnect("node-a");
  assert.deepEqual(ended, ["disconnected"]);
  assert.throws(() => hub.subscribe("node-a", terminalId, 0, () => undefined), /not found/);
});

test("host Agent reads output with a cursor and event-driven bounded waiting", async () => {
  const hub = new LanAgentTerminals(async (_instance, body) => ({ terminalId: body.terminalId, state: "running" }));
  const terminalId = randomUUID(); await hub.execute("node-a", { action: "open", terminalId });
  const waiting = hub.read("node-a", terminalId, 0, 1000);
  hub.receive("node-a", { terminalId, type: "output", data: "result" });
  const result = await waiting as { outputEvents: Array<{ data: string }>; nextOutputSequence: number; truncated: boolean };
  assert.equal(result.outputEvents[0]!.data, "result"); assert.equal(result.nextOutputSequence, 1); assert.equal(result.truncated,false);
  const disconnected = hub.read("node-a",terminalId,1,1000); hub.disconnect("node-a");
  await assert.rejects(disconnected,/changed/);
});

test("terminal replay count and observer count do not reject valid work",async()=>{
 const hub=new LanAgentTerminals(async(_instance,body)=>({terminalId:body.terminalId,state:"running"})),live=randomUUID();
 await hub.execute("node",{action:"open",terminalId:live});let received=0;const observers=Array.from({length:9},()=>hub.subscribe("node",live,0,()=>received++));
 hub.receive("node",{terminalId:live,type:"output",data:"all observers"});assert.equal(received,9);
 for(let i=0;i<140;i++){const terminalId=randomUUID();await hub.execute("node",{action:"open",terminalId});hub.receive("node",{terminalId,type:"exit",exitCode:0});}
 const result=await hub.read("node",live,0) as {outputEvents:unknown[]};assert.equal(result.outputEvents.length,1);observers.forEach(stop=>stop());
});


test("terminal failed admission removes only its own new empty placeholder before yielding", async () => {
  let fail = true, calls = 0;
  const hub = new LanAgentTerminals((_instance, body) => {
    calls++;
    if (fail) throw new TerminalDispatchNotSentError(new Error("Original connection was unavailable before dispatch."));
    return Promise.resolve({ terminalId: body.terminalId, state: "running" });
  });
  const terminalId = randomUUID();
  const rejected = hub.execute("node", { action: "open", terminalId });
  fail = false;
  const accepted = hub.execute("node", { action: "open", terminalId });
  await assert.rejects(rejected, TerminalDispatchNotSentError); await accepted;
  const stop = hub.subscribe("node", terminalId, 0, () => {}); stop();
  fail = true;
  await assert.rejects(hub.execute("node", { action: "open", terminalId }), TerminalDispatchNotSentError);
  const existing = hub.subscribe("node", terminalId, 0, () => {}); existing();
  assert.equal(calls, 3);
});

test("terminal replay retains observed events even if a local invocation reports no dispatch", async () => {
  let hub: LanAgentTerminals;
  hub = new LanAgentTerminals((instance, body) => {
    hub.receive(instance, { terminalId: body.terminalId, type: "output", data: "already observed" });
    throw new TerminalDispatchNotSentError(new Error("Before this dispatch."));
  });
  const terminalId = randomUUID(); await assert.rejects(hub.execute("node", { action: "open", terminalId }));
  const observed: string[] = [];
  const stop = hub.subscribe("node", terminalId, 0, event => observed.push(event.data ?? "")); stop();
  assert.deepEqual(observed, ["already observed"]);
});

for (const reason of ["Instance management timed out; refresh before retrying a change.", "Instance disconnected during management."]) {
  test(`terminal accepted dispatch keeps its original ID on ${reason}`, async () => {
    let calls = 0, rejectOriginal!: (error: Error) => void;
    const hub = new LanAgentTerminals(() => { calls++; return new Promise((_resolve, reject) => { rejectOriginal = reject; }); });
    const terminalId = randomUUID(), pending = hub.execute("node", { action: "open", terminalId });
    rejectOriginal(new Error(reason)); await assert.rejects(pending, error => error instanceof Error && error.message === reason);
    const stop = hub.subscribe("node", terminalId, 0, () => {}); stop();
    assert.equal(calls, 1);
  });
}

test("terminal cleanup does not trust peer error names, codes or not-sent fields", async () => {
  let calls = 0;
  const hub = new LanAgentTerminals(() => { calls++; throw Object.assign(new Error("not_sent"), {
    name: "TerminalDispatchNotSentError", code: "LAN_AGENT_MANAGEMENT_NOT_SENT", deliveryFrameSent: false
  }); });
  const terminalId = randomUUID(); await assert.rejects(hub.execute("node", { action: "open", terminalId }));
  const stop = hub.subscribe("node", terminalId, 0, () => {}); stop();
  assert.equal(calls, 1);
});

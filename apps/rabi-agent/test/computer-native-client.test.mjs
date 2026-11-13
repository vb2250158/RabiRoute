import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { NativeComputerClient } from "../lib/computer-native-client.mjs";
import { ComputerControlService } from "../lib/computer-control-service.mjs";
import { computerSourceSchema } from "../lib/interactive-protocol.mjs";

function childFixture(onWrite) {
  const child = new EventEmitter(); child.pid = 1; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { onWrite?.(String(chunk), child); done(); } });
  child.stdin.once("finish", () => setImmediate(() => child.emit("close", 0)));
  return child;
}

test("native correlation ID and action cannot be overwritten by request body fields", async () => {
  let sent;
  const child = childFixture((line, current) => {
    sent = JSON.parse(line);
    setImmediate(() => current.stdout.write(JSON.stringify({ id: sent.id, result: { state: "observed" } }) + "\n"));
  });
  const client = new NativeComputerClient({ launch: () => child });
  assert.equal((await client.request("capabilities", { id: "caller-id", action: "input.execute" })).state, "observed");
  assert.notEqual(sent.id, "caller-id"); assert.equal(sent.action, "capabilities");
  await client.close();
});

test("native process startup failure rejects the pending call immediately and closes its Qt owner", async () => {
  const child = childFixture(); child.pid = undefined;
  const client = new NativeComputerClient({ launch: () => { setImmediate(() => child.emit("error", new Error("fixture executable absent"))); return child; }, timeout: () => 1000 });
  const started = performance.now();
  await assert.rejects(client.request("capabilities"), error => error.code === "COMPUTER_NATIVE_START_FAILED" && !error.uncertain);
  assert.ok(performance.now() - started < 500);
  await client.close();
  let closed = 0;
  const noNative = new NativeComputerClient();
  noNative.qt = { close: async () => { closed++; } };
  await noNative.close(); assert.equal(closed, 1);
});

test("native responses can arrive out of order while a slow capture is pending", async () => {
  const pending = [];
  const child = childFixture(line => pending.push(JSON.parse(line)));
  const client = new NativeComputerClient({ launch: () => child });
  const capture = client.request("screen.capture");
  const ending = client.request("control.end", { controlSessionId: "original" });
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(JSON.stringify({ id: pending[1].id, result: { state: "ended" } }) + "\n");
  assert.equal((await ending).state, "ended");
  child.stdout.write(JSON.stringify({ id: pending[0].id, result: { frameId: "old-observation" } }) + "\n");
  assert.equal((await capture).frameId, "old-observation");
  await client.close();
});

test("a control intent cancelled during Qt startup never reaches the native command pipe", async () => {
  let ready, sends = 0, cancelled = false;
  const client = new NativeComputerClient({ launch: () => { sends++; return childFixture(); } });
  client.qt = { start: () => new Promise(resolve => { ready = resolve; }), close: async () => {} };
  const pending = client.request("control.begin", { controlSessionId: "old" }, { beforeSend: () => { if (cancelled) throw Object.assign(new Error("Original owner ended"), { code: "COMPUTER_SOURCE_CLOSED" }); } });
  cancelled = true; ready();
  await assert.rejects(pending, error => error.code === "COMPUTER_SOURCE_CLOSED");
  assert.equal(sends, 0);
  await client.close();
});

test("chunked screenshot frames and a following control reply keep their original boundaries", async () => {
  const data = "a".repeat(1024 * 1024);
  const child = childFixture((line, current) => {
    const request = JSON.parse(line);
    const response = JSON.stringify({ id: request.id, result: { frameId: "fixture-frame", data } }) + "\n";
    setImmediate(() => { for (let offset = 0; offset < response.length; offset += 4096) current.stdout.write(response.slice(offset, offset + 4096)); });
  });
  const client = new NativeComputerClient({ launch: () => child });
  const result = await client.request("screen.capture");
  assert.equal(result.frameId, "fixture-frame"); assert.equal(result.data.length, data.length);
  await client.close();
});


test("late presentation cannot start Qt after native retirement and final Qt close is joined", async()=>{
  let sent;const child=childFixture(line=>{sent=JSON.parse(line);setImmediate(()=>child.stdout.write(JSON.stringify({id:sent.id,result:{protocolVersion:2}})+'\n'));});
  child.stdin.removeAllListeners('finish');
  const client=new NativeComputerClient({launch:()=>child});let updates=0,closeCalls=0,release;
  const finalQtClose=new Promise(resolve=>{release=resolve;});
  client.qt={update:async()=>{updates++;},close:async()=>{closeCalls++;if(closeCalls>1)await finalQtClose;}};client.qtAvailable=true;
  await client.request('capabilities');let ended=false;const closing=client.close().then(()=>{ended=true;});
  child.stdout.write(JSON.stringify({event:'presentation',data:{revision:1}})+'\n');
  child.emit('close',0);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updates,0);assert.equal(ended,false);release();await closing;assert.equal(ended,true);
});

test("input timeout cancels the original native request and supplies a native deadline", async () => {
  const sent = [];
  const child = childFixture((line,current) => { const request=JSON.parse(line);if(request.action==="capabilities"){setImmediate(()=>current.stdout.write(JSON.stringify({id:request.id,result:{protocolVersion:2,inputBatchVersion:1,captureSpecVersion:1}})+"\n"));return;}sent.push(request);if(request.action==="input.cancel")setImmediate(()=>current.stdout.write(JSON.stringify({id:request.id,result:{state:"cancelled",workState:"settled"}})+"\n")); });
  const client = new NativeComputerClient({launch:()=>child,timeout:()=>20});
  const started=Date.now();
  await assert.rejects(client.request("input.execute",{requestId:"original-batch",controlSessionId:"original-session",actions:[{type:"move",x:0,y:0}],deadlineUtcMs:1}),error=>error.uncertain&&error.cancellationRequested&&error.requestId==="original-batch");
  assert.ok(sent[0].deadlineUtcMs>=started+15);assert.ok(sent[0].deadlineUtcMs<=Date.now()+20);
  assert.equal(sent[1].action,"input.cancel");assert.equal(sent[1].requestId,"original-batch");assert.equal(sent[1].controlSessionId,"original-session");assert.notEqual(sent[0].id,sent[1].id);
  await new Promise(resolve=>setImmediate(resolve));await client.close();
});

test("Qt stop maps only existing recovery actions and IDs without starting its renderer", async () => {
  const sent=[];const child=childFixture((line,current)=>{const request=JSON.parse(line);sent.push(request);setImmediate(()=>current.stdout.write(JSON.stringify({id:request.id,result:{state:"stopped"}})+"\n"));});
  const client=new NativeComputerClient({launch:()=>child});let startups=0;client.qt={start:async()=>{startups++;},close:async()=>{}};
  client.stopOperation({action:"screen.capture",requestId:"bad"});
  client.stopOperation({action:"input.cancel",requestId:"batch",controlSessionId:"session",unrelated:"ignored"});
  client.stopOperation({action:"annotation.track.stop",trackingId:"tracker"});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(startups,0);assert.deepEqual(sent.map(item=>item.action),["input.cancel","annotation.track.stop"]);assert.equal(sent[0].unrelated,undefined);
  await client.close();
});

test("unsupported native selectors and batches fail before executing instead of being ignored", async () => {
  const sent=[];
  const child=childFixture((line,current)=>{const request=JSON.parse(line);sent.push(request);setImmediate(()=>current.stdout.write(JSON.stringify({id:request.id,result:{protocolVersion:2}})+"\n"));});
  const client=new NativeComputerClient({launch:()=>child});
  await assert.rejects(client.request("input.execute",{actions:[{type:"text",text:"A"}]}),error=>error.code==="COMPUTER_NATIVE_FEATURE_UNSUPPORTED"&&error.field==="inputBatchVersion");
  await assert.rejects(client.request("screen.capture",{captureSpec:{scope:"region",displayId:"A",region:{x:0,y:0,width:2,height:2}}}),error=>error.code==="COMPUTER_NATIVE_FEATURE_UNSUPPORTED"&&error.field==="captureSpecVersion");
  await assert.rejects(client.request("displays.list"),error=>error.code==="COMPUTER_NATIVE_FEATURE_UNSUPPORTED");
  assert.deepEqual(sent.map(item=>item.action),["capabilities"]);await client.close();
});

test('image view schema separates stable frame dimensions from presented coordinates', () => {
  const view = computerSourceSchema.properties.imageView;
  assert.deepEqual(view.required, ['width', 'height']);
  assert.equal(view.additionalProperties, false);
  assert.deepEqual(view.properties.width, { type: 'integer', minimum: 1, maximum: 2147483647 });
  assert.deepEqual(view.properties.height, view.properties.width);
  assert.match(computerSourceSchema.description, /base width\/height/);
  assert.match(computerSourceSchema.description, /tracking coordinates use imageView/);
});

for (const action of ['input.execute', 'annotation.show', 'annotation.update', 'annotation.track.start']) {
  test(`resized image coordinates require native imageViewVersion for ${action}`, async () => {
    const sent = [];
    const child = childFixture((line, current) => {
      const request = JSON.parse(line); sent.push(request);
      setImmediate(() => current.stdout.write(JSON.stringify({ id: request.id, result: { inputBatchVersion: 1 } }) + '\n'));
    });
    const client = new NativeComputerClient({ launch: () => child });
    await assert.rejects(client.request(action, { source: { coordinateSpace: "capture", width: 1920, height: 1080, imageView: { width: 512, height: 288 } },
      ...(action === "input.execute" ? { actions: [{ type: "click", x: 256, y: 144 }] } : {}) }),
      error => error.code === 'COMPUTER_NATIVE_FEATURE_UNSUPPORTED' && error.field === 'imageViewVersion');
    assert.deepEqual(sent.map(item => item.action), ['capabilities']);
    await client.close();
  });
}

test('image view and input batch checks share one cached native capability request', async () => {
  const sent = [];
  const child = childFixture((line, current) => {
    const request = JSON.parse(line); sent.push(request);
    setImmediate(() => current.stdout.write(JSON.stringify({ id: request.id, result: request.action === 'capabilities'
      ? { imageViewVersion: 1, inputBatchVersion: 1 } : { state: 'accepted', source: request.source } }) + '\n'));
  });
  const client = new NativeComputerClient({ launch: () => child });
  const source = { frameId: 'original', width: 1920, height: 1080, imageView: { width: 512, height: 288 } };
  const results = await Promise.all([
    client.request('input.execute', { source, actions: [{ type: 'move', x: 256, y: 144 }] }),
    client.request('annotation.show', { source }),
  ]);
  assert.deepEqual(results.map(value => value.source), [source, source]);
  assert.equal(sent.filter(item => item.action === 'capabilities').length, 1);
  await client.close();
});


for (const [name, input] of [
  ["overview", {}],
  ["window", { windowId: "a1", pid: 42 }],
  ["source window", { source: { windowId: "a1", pid: 42 } }],
]) {
  test(`legacy native remains usable for ordinary ${name} capture`, async () => {
    const sent = [];
    const child = childFixture((line, current) => {
      const request = JSON.parse(line);
      sent.push(request);
      const result = request.action === "capabilities" ? { protocolVersion: 2 } : { frameId: "legacy-frame" };
      setImmediate(() => current.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
    });
    const native = new NativeComputerClient({ launch: () => child });
    const owner = new ComputerControlService({ native, instanceId: "fixture-computer" });
    try {
      const result = await owner.capture(input, { sourceId: "fixture-connection" });
      assert.equal(result.frameId, "legacy-frame");
      assert.deepEqual(sent.map(request => request.action), ["screen.capture"]);
      assert.equal(sent[0].captureSpec, undefined);
    } finally {
      await owner.stop();
    }
  });
}


test("view metadata that does not change native coordinates needs no imageView capability", async () => {
  const sent = [];
  const child = childFixture((line, current) => {
    const request = JSON.parse(line); sent.push(request);
    const result = request.action === "capabilities" ? { inputBatchVersion: 1 } : { state: "accepted" };
    setImmediate(() => current.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
  });
  const client = new NativeComputerClient({ launch: () => child });
  try {
    const source = { coordinateSpace: "capture", width: 1920, height: 1080, imageView: { width: 512, height: 288 } };
    await client.request("input.execute", { source, actions: [{ type: "text", text: "fixture" }] });
    await client.request("input.execute", { source, actions: [{ type: "scroll", y: 144, deltaY: 1 }] });
    await client.request("input.execute", { source: { ...source, imageView: { width: 1920, height: 1080 } }, actions: [{ type: "click", x: 256, y: 144 }] });
    assert.deepEqual(sent.map(request => request.action), ["capabilities", "input.execute", "input.execute", "input.execute"]);
  } finally {
    await client.close();
  }
});

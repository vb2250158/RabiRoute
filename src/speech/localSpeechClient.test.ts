import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from 'node:http';
import { localSpeechEndpoint, normalizeLocalSpeechServiceUrl, requestLocalSpeech } from "./localSpeechClient.js";

test("speech URL accepts user-configured local and remote HTTP services", () => {
  assert.equal(normalizeLocalSpeechServiceUrl("http://127.0.0.1:8781/"), "http://127.0.0.1:8781");
  assert.equal(localSpeechEndpoint("http://localhost:8781", "/v1/models"), "http://localhost:8781/v1/models");
  assert.equal(normalizeLocalSpeechServiceUrl("https://example.com"), "https://example.com");
  assert.throws(() => normalizeLocalSpeechServiceUrl("file:///tmp/speech"), /HTTP/);
});

test("local speech response exposes only allowlisted metadata", async () => {
  const fetchImpl: typeof fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "x-rabispeech-model": "gpt-sovits",
      "set-cookie": "secret=1"
    }
  });
  const response = await requestLocalSpeech("https://speech.example.test", "/v1/audio/speech", {}, { fetchImpl });
  assert.equal(response.contentType, "audio/wav");
  assert.equal(response.headers["x-rabispeech-model"], "gpt-sovits");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual([...response.body], [1, 2, 3]);
});

test('caller cancellation reaches the original speech transport without retrying or waiting for its timeout',async()=>{
  const parent=new AbortController(),reason=Error('CALLER_CANCELLED');let calls=0;
  const fetchImpl:typeof fetch=async(url,init)=>{
    calls++;assert.equal(String(url),'http://127.0.0.1:9876/v1/audio/speech');
    return new Promise((_resolve,reject)=>{
      const signal=init!.signal!;
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      queueMicrotask(()=>parent.abort(reason));
    });
  };
  await assert.rejects(requestLocalSpeech('http://127.0.0.1:9876','/v1/audio/speech',{signal:parent.signal},{fetchImpl,timeoutMs:80}),error=>error===reason);
  assert.equal(calls,1);
});

test('an already cancelled speech request cannot dispatch even if the native fetcher ignores cancellation',async()=>{
  const parent=new AbortController(),reason=Error('ALREADY_CANCELLED');parent.abort(reason);let calls=0;
  await assert.rejects(requestLocalSpeech('https://speech.example.test','/v1/audio/speech',{signal:parent.signal},{fetchImpl:async()=>{calls++;return new Response(new Uint8Array([1]))}}),error=>error===reason);
  assert.equal(calls,0);
});

test('caller cancellation also aborts reading an unfinished real HTTP audio response',async()=>{
  let calls=0;
  const server=createServer((_request,response)=>{calls++;response.writeHead(200,{'content-type':'audio/wav'});response.flushHeaders()});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const parent=new AbortController(),reason=Error('BODY_CANCELLED');let forwarded:AbortSignal;
  try{
    await assert.rejects(requestLocalSpeech(`http://127.0.0.1:${address.port}`,'/v1/audio/speech',{signal:parent.signal},{timeoutMs:2000,fetchImpl:async(url,init)=>{
      forwarded=init!.signal!;const response=await fetch(url,init);queueMicrotask(()=>parent.abort(reason));return response;
    }}),error=>error===reason||error instanceof Error&&error.name==='AbortError');
    assert.equal(forwarded!.reason,reason);assert.equal(calls,1);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});

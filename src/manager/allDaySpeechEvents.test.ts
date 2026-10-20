import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { watchAllDaySpeechEvents } from "./allDaySpeechEvents.js";

test("record subscription handles split CRLF frames, ignores levels/TTS, and closes with its owner", async t => {
  let closed!: () => void;
  const done = new Promise<void>(resolve => { closed=resolve; });
  const server=http.createServer((_request,response)=>{
    response.on("close",closed);response.writeHead(200,{"content-type":"text/event-stream"});
    response.write("event: ready\r\ndata: {}\r\n\r\nevent: records_ch");
    setImmediate(()=>response.write('anged\r\ndata: {"id":"one","kind":"asr"}\r\n\r\nevent: records_changed\ndata: {"id":"tts","kind":"tts"}\n\nevent: microphone_level\ndata: {}\n\n'));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const values:(string|undefined)[]=[];
  const stop=watchAllDaySpeechEvents(()=>`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,id=>values.push(id),error=>assert.fail(error));
  t.after(stop);
  for(let i=0;i<100&&values.length<2;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(values,[undefined,"one"]);stop();await done;
});

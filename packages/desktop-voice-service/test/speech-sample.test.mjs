import test from 'node:test';import assert from 'node:assert/strict';import {recognizeStreamSample} from '../src/speech-sample.mjs';
const wav=()=>{const b=Buffer.alloc(44+4096);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4096,40);return b};
test('sample recognition feeds actual PCM through the provider adapter and releases its recording',async()=>{
 let handlers,recording,frames=0,disposed=false,stopped=false;
 const result=await recognizeStreamSample({audio:wav(),createAsr:({createRecording})=>({createRound(value){handlers=value;recording=createRecording();return{}},async start(){await recording.start(()=>{},{onPcm:bytes=>{frames++;assert.equal(bytes.length,4096);handlers.onFinal({text:'sample'})}})},async stop(){stopped=true;await recording.dispose();disposed=true}})});
 assert.equal(result.text,'sample');assert.equal(frames,1);assert.ok(stopped&&disposed);
});
test('unsupported sample format never opens a provider or microphone',async()=>{
 const audio=wav();audio.writeUInt16LE(2,22);await assert.rejects(recognizeStreamSample({audio,createAsr:()=>assert.fail('must not open')}),/SPEECH_SAMPLE_FORMAT/);
});

test('continuous sample acceptance keeps feeding silence until provider final without sending EOF',async()=>{
 let handlers,recording,bytes=0,frames=0;
 const result=await recognizeStreamSample({audio:wav(),endInput:false,createAsr:({createRecording})=>({
   createRound(value){handlers=value;recording=createRecording();return{}},
   async start(){await recording.start(()=>{},{onPcm:chunk=>{bytes+=chunk.length;frames++;if(bytes>4096+64000)handlers.onFinal({text:'automatic final'})}})},
   finish(){assert.fail('EOF must not make this continuous test pass')},
   async stop(){await recording.dispose()},
 })});
 assert.equal(result.text,'automatic final');assert.ok(frames>17);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRecognitionSample,recognitionSampleSource} from '../src/recognition-sample.mjs';

// The real shipped diagnostic input must work even without an OS speech installation.
test('bundled public Mandarin sample matches its source and needs no system voice',async()=>{
  const wav=await createRecognitionSample();
  const source=JSON.parse(await readFile(new URL('../assets/diagnostics/source.json',import.meta.url),'utf8'));
  assert.equal(recognitionSampleSource,source.id);
  assert.equal(wav.length,source.bytes);
  assert.equal(createHash('sha256').update(wav).digest('hex'),source.sha256);
  assert.equal(source.language,'zh-CN');assert.equal(source.license,'MIT');
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,16),'WAVEfmt ');
  assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),16000);
  assert.equal(wav.readUInt16LE(34),16);assert.equal(wav.readUInt32LE(40),wav.length-44);
  const license=await readFile(new URL('../assets/diagnostics/LICENSE.Microsoft.txt',import.meta.url),'utf8');
  assert.match(license,/MIT License/);assert.match(license,/Copyright \(c\) Microsoft Corporation/);
});

test('missing, unreadable and corrupt packaged samples fail without pretending to test ASR',async()=>{
  await assert.rejects(createRecognitionSample({read:async()=>{throw Error('private local path')}}),/^Error: ASR_SAMPLE_SOURCE_UNAVAILABLE$/);
  const wav=await createRecognitionSample();
  for(const bytes of [Buffer.alloc(0),wav.subarray(0,30),Buffer.alloc(44),Buffer.from(wav)]) {
    if(bytes.length===wav.length)bytes.writeUInt32LE(8000,24);
    await assert.rejects(createRecognitionSample({read:async()=>bytes}),/^Error: ASR_SAMPLE_SOURCE_UNAVAILABLE$/);
  }
});

test('a host-provided resource URL uses the same reader and format validation',async()=>{
  const url=new URL('file:///packaged-diagnostic/recognition-zh-CN.wav');
  const source=await createRecognitionSample();
  const wav=await createRecognitionSample({url,read:async value=>{assert.equal(value,url);return source;}});
  assert.deepEqual(wav,source);
});

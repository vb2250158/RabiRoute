import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManagedResidentSpeech } from '../src/resident-speech.mjs';
import { spawnOwnedProcess } from '../src/windows-job.mjs';

const nativeWindows = process.platform === 'win32' && process.arch === 'x64';

test('only one owned capture child serves concurrent callers and disposal closes its transport', { skip: !nativeWindows, timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rabi-resident-speech-'));
  const configPath = join(root, 'config.json'), program = join(root, 'fixture.cjs');
  await writeFile(configPath, '{}');
  const service = join(root,'service');
  await mkdir(join(service,'scripts'),{recursive:true});
  await writeFile(join(service,'scripts','assistant_capture_host.py'),'');
  await writeFile(program, `
    const {createServer} = require('node:http');
    const {renameSync,writeFileSync} = require('node:fs');
    if (!process.argv[2].endsWith('assistant_capture_host.py') || process.env.RABIROUTE_MANAGER_URL) process.exit(1);
    const prefix = '/v1/internal/assistant-';
    const token = process.env.RABISPEECH_ASSISTANT_AUDIO_TOKEN;
    const ready = process.env.RABISPEECH_ASSISTANT_READY_FILE;
    const server = createServer(async (request,response) => {
      if (!token || request.headers['x-rabispeech-assistant-token'] !== token) {
        response.writeHead(403).end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === prefix + 'transcribe' && request.headers['content-type'] === 'audio/wav') {
        response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({text:'测试句子'}));
      } else if (request.url === prefix + 'wake') {
        response.writeHead(200,{'content-type':'application/x-ndjson'}).end(JSON.stringify(JSON.parse(Buffer.concat(chunks))));
      } else if (request.url.startsWith(prefix + 'capture')) {
        response.writeHead(200,{'content-type':'application/octet-stream'}).write('pcm');
      } else {
        response.writeHead(200).end();
      }
    });
    server.listen(0,'127.0.0.1',()=>{
      writeFileSync(ready + '.tmp', JSON.stringify({schemaVersion:1,mode:'assistant-capture',pid:process.pid,
        nonce:process.env.RABISPEECH_ENDPOINT_NONCE,host:'127.0.0.1',port:server.address().port}));
      renameSync(ready + '.tmp',ready);
    });
  `);
  let started = 0, child;
  const speech = createManagedResidentSpeech({ executable:process.execPath, configPath, workspaceRoot:root, serviceRoot:service,
    launch: options => {
      started++;
      child = spawnOwnedProcess({ ...options, args:[program,...options.args] });
      return child;
    } });
  const signal = AbortSignal.timeout(8000);
  try {
    const [response, text] = await Promise.all([
      speech.openAssistantWake(['夜雨'],signal),
      speech.transcribeAssistantAudio(Buffer.alloc(52),signal),
    ]);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {aliases:['夜雨']});
    assert.deepEqual(text, {text:'测试句子'});
    assert.equal(started,1);
    const capture = await speech.openAssistantCapture(signal);
    const closed = new Promise(resolve=>capture.once('close',resolve));
    await speech.dispose();
    await closed;
    assert.equal(child.exitCode(),null);
    assert.deepEqual((await readdir(root)).sort(), ['config.json','fixture.cjs','service']);
    await assert.rejects(speech.openAssistantWake(['夜雨'], signal), {name:'AbortError'});
  } finally {
    await speech.dispose();
    await rm(root,{recursive:true,force:true});
  }
});

test('capture cannot launch using a configuration outside its private owner directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rabi-resident-config-'));
  const configPath = join(root,'config.json');
  await writeFile(configPath,'{}');
  const speech = createManagedResidentSpeech({
    executable:process.execPath, configPath, workspaceRoot:join(root,'private'),
    launch: () => assert.fail('out-of-scope configuration reached the launcher'),
  });
  try {
    await assert.rejects(speech.openAssistantWake(['夜雨'], AbortSignal.timeout(2000)), {
      message:'ASSISTANT_SPEECH_LOCAL_CONFIGURATION_REQUIRED',
    });
  } finally {
    await speech.dispose();
    await rm(root,{recursive:true,force:true});
  }
});

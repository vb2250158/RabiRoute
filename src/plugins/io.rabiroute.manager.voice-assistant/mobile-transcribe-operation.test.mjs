import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createVoiceAssistantOperations } from './src/operations.mjs';

function transcribeOperation(transcribeMobile) {
  return createVoiceAssistantOperations({ transcribeMobile }, execute => execute())
    .find(operation => operation.contract.operationId === 'manager.voice-assistant.mobile-transcribe');
}

test('mobile transcription passes the WAV bytes from the HTTP request to the recognizer', async () => {
  const wav = Buffer.alloc(60);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  const signal = new AbortController().signal;
  const operation = transcribeOperation(({ audio, source, sessionId, signal: passedSignal }) => {
    assert.deepEqual(audio, wav);
    assert.equal(source, 'local');
    assert.equal(sessionId, 'session');
    assert.equal(passedSignal, signal);
    return { text: '识别成功' };
  });
  const reply = await operation.handler({
    body: Readable.from([wav.subarray(0, 11), wav.subarray(11)]),
    query: { source: 'local', sessionId: 'session' },
    signal,
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { text: '识别成功' });
});

test('mobile transcription rejects an oversized chunked request before recognition', async () => {
  const operation = transcribeOperation(() => assert.fail('The recognizer received an oversized request'));
  const limit = operation.contract.request.body.maxBytes;
  const reply = await operation.handler({
    body: Readable.from([Buffer.alloc(limit), Buffer.from([0])]),
    query: { source: 'local', sessionId: 'session' },
  });
  assert.equal(reply.status, 413);
  assert.equal(reply.body.message, 'MOBILE_ASR_AUDIO_TOO_LARGE');
});

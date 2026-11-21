import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { openMobileAsrStream } from './src/mobile-asr-stream.mjs';
import { createVoiceAssistantOperations } from './src/operations.mjs';

function fixture({ start, endSamples } = {}) {
  const request = new PassThrough();
  const signal = new AbortController();
  const pcm = [];
  let stopped = 0;
  const stream = openMobileAsrStream({ request, signal: signal.signal, assertCurrent() {},
    observationOf: value => ({ emotion: value.emotion }),
    createAsr({ createRecording }) {
      const recording = createRecording();
      return {
        createRound: handlers => handlers,
        async start(round) {
          await start?.();
          await recording.start(round.onError, { onPcm: bytes => {
            pcm.push(bytes);
            round.onInterim({ text: '今天天气' });
          } });
          round.onStart();
        },
        async finish(round) {
          for (const endSample of endSamples ?? [undefined]) {
            round.onFinal({ text: '今天天气怎么样？', endSample, additions: { emotion: 'neutral', secret: 'omit' } });
          }
          round.onEnd();
        },
        async stop() { stopped++; await recording.dispose(); },
      };
    },
  });
  return { request, stream, signal, pcm, stopped: () => stopped };
}

test('mobile PCM streams partial results before EOF and filters provider metadata', async () => {
  const run = fixture();
  const frames = run.stream.frames[Symbol.asyncIterator]();
  assert.deepEqual(JSON.parse((await frames.next()).value.toString()), { type: 'ready' });
  run.request.write(Buffer.from([0, 1, 2]));
  assert.deepEqual(JSON.parse((await frames.next()).value.toString()), { type: 'interim', text: '今天天气' });
  run.request.end(Buffer.from([3]));
  const tail = [];
  for await (const chunk of frames) tail.push(...chunk.toString().trim().split('\n').map(JSON.parse));
  assert.deepEqual(Buffer.concat(run.pcm), Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(tail.at(-1), { type: 'final', text: '今天天气怎么样？', observation: { emotion: 'neutral' } });
  assert.equal(run.stopped(), 1);
});

test('final replay offsets are positive monotonic integer positions within forwarded PCM', async () => {
  const run = fixture({endSamples: [0, 2, 2, 1, 12, 2.5, 4]});
  const frames = run.stream.frames[Symbol.asyncIterator]();
  await frames.next();
  run.request.end(Buffer.alloc(8));
  const results = [];
  for await (const chunk of frames) {
    results.push(...chunk.toString().trim().split('\n').map(JSON.parse));
  }
  assert.deepEqual(results.filter(item => item.type === 'final').map(item => item.endSample),
    [undefined, 2, undefined, undefined, undefined, undefined, 4]);
});

test('an incomplete frame ends the stream with a safe error and releases the provider', async () => {
  const run = fixture();
  const frames = run.stream.frames[Symbol.asyncIterator]();
  await frames.next();
  run.request.end(Buffer.from([0]));
  assert.deepEqual(JSON.parse((await frames.next()).value.toString()), { type: 'error', error: 'MOBILE_STREAM_ASR_FAILED' });
  assert.equal((await frames.next()).done, true);
  assert.equal(run.stopped(), 1);
});

test('abort unblocks a pending response and stops capture', async () => {
  const run = fixture();
  const frames = run.stream.frames[Symbol.asyncIterator]();
  await frames.next();
  const next = frames.next();
  run.signal.abort();
  assert.equal((await next).done, true);
  assert.equal(run.stopped(), 1);
});

test('mobile ASR HTTP admission passes raw PCM and the frozen session to the owner', async () => {
  const request = new PassThrough();
  const signal = new AbortController().signal;
  const stream = { frames: (async function* () {})(), cancel() {} };
  const [operation] = createVoiceAssistantOperations({
    openMobileAsr(input) { assert.deepEqual(input, { request, sessionId: 'original', signal }); return stream; },
  }, callback => callback()).filter(item => item.contract.operationId.endsWith('.mobile-asr'));
  assert.equal(operation.contract.request.body.kind, 'stream');
  assert.equal(operation.contract.responses[200].mediaType, 'application/x-ndjson');
  const response = await operation.handler({ body: request, query: { sessionId: 'original' }, signal });
  assert.equal(response.status, 200);
  assert.equal(response.stream, stream);
});

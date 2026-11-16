import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemRecognitionSample } from '../src/recognition-sample.mjs';
import { createSystemPcmFixture } from './fixtures/diagnostic-inputs.mjs';

test('OS-generated PCM becomes a mono 16 kHz WAV without recording or a shell', async () => {
  const pcm = createSystemPcmFixture();
  const wav = await createSystemRecognitionSample({ platform: 'win32', run: async (executable, args, options) => {
    assert.ok(executable.endsWith('powershell.exe'));
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.ok(args[3].includes('System.Speech.Synthesis.SpeechSynthesizer'));
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    return { stdout: pcm.toString('base64') };
  } });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('unsupported hosts and unavailable or invalid synthesis fail explicitly', async () => {
  await assert.rejects(createSystemRecognitionSample({ platform: 'linux', run: () => assert.fail('must not run') }), /ASR_SAMPLE_SOURCE_UNAVAILABLE/);
  await assert.rejects(createSystemRecognitionSample({ platform: 'win32', run: async () => { throw Error('local failure details') } }), /^Error: ASR_SAMPLE_SOURCE_UNAVAILABLE$/);
  for (const stdout of ['', 'not base64!', 'AQ==']) {
    await assert.rejects(createSystemRecognitionSample({ platform: 'win32', run: async () => ({ stdout }) }), /ASR_SAMPLE_SOURCE_UNAVAILABLE/);
  }
});

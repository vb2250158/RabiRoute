import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app/src/main/java/com/rabi/link/modules/rokid/RabiLiveRecordingController.kt', import.meta.url), 'utf8');

test('video controller does not own Android services, capture lock or notifications', () => {
  assert.match(source, /ContextWrapper\(context\.applicationContext\), AutoCloseable/);
  assert.doesNotMatch(source, /\b(?:startForeground|stopForeground|startService|stopService|stopSelf|NotificationManager|CaptureOwnership)\b/);
});

test('public controller API remains compatible with coordinator and preview UI', () => {
  for (const signature of ['fun start(auto: Boolean)', 'fun stop()', 'override fun close()', 'fun urls(): List<String>', 'fun listen(listener: () -> Unit)', 'fun unlisten(listener: () -> Unit)']) {
    assert.ok(source.includes(signature), signature);
  }
  for (const property of ['running', 'receiving', 'receivedAt', 'sessionId', 'status']) {
    assert.match(source, new RegExp(`var ${property} = [^\\n]+; private set`));
  }
  assert.match(source, /val streamKey: String/);
});

test('close fences delayed opening and completion retains durable save boundary', () => {
  assert.ok(source.includes('if (closed || active) return@onMain'));
  assert.ok(source.includes('if (!closed && !stopping && active && generation == epoch && videoController === controller) controller.start()'));
  assert.ok(source.includes('main.removeCallbacks(it)'));
  const save = source.indexOf('RecordingStore(this).finish(id, result)');
  const complete = source.indexOf('onStopped()', save);
  assert.ok(save > 0 && complete > save);
  assert.match(source, /owned\.waitFor\(\)/);
  assert.equal((source.match(/onStopped\(\)/g) || []).length, 1, 'one terminal callback publication site');
});

test('existing recording and preview contracts are preserved', () => {
  assert.ok(source.includes('getSharedPreferences("rabi_live_recorder"'));
  for (const setting of ['recordFormat: fmp4', 'recordPartDuration: 1s', 'recordSegmentDuration: 1m', 'recordDeleteAfter: 0s', 'rtspAddress: 127.0.0.1:${mediaSettings.previewPort}', 'overridePublisher: false']) {
    assert.ok(source.includes(setting), setting);
  }
  assert.doesNotMatch(source, /deleteRecursively|\.delete\(/);
});

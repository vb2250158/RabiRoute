import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../app/src/main/java/com/rabi/link/modules/rokid/RabiGlassStatusPublisher.kt', import.meta.url), 'utf8');
test('publisher consumes callbacks without owning device or background service', () => {
  assert.doesNotMatch(source, /new RokidCxrController|RokidCxrController\(|startService|startForeground|Notification|postDelayed|Timer\(/);
  assert.ok(source.includes('fun accept(battery: Int, charging: Boolean)'));
  assert.ok(source.includes('fun onNetworkAvailable()'));
});
test('publishing checks consent and immutable endpoint credential binding', () => {
  assert.ok(source.includes('!settings.running || !settings.uploadEnabled'));
  assert.ok(source.includes('data.getString("binding") != identity(relay.baseUrl, relay.token)'));
  assert.doesNotMatch(source, /\.put\("token"/);
  assert.ok(source.includes('data.getString("observedAt")'));
});

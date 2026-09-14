import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = 'apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/wearable/';
const read = p => readFileSync(p, 'utf8');
test('health controller is not a service and has no notification or timer owner', () => {
 const s = read(root + 'WearableHealthController.kt');
 assert.match(s, /class WearableHealthController/);
 assert.doesNotMatch(s, /: Service\(|startForeground|NotificationManager|BootReceiver|postDelayed/);
 for (const field of ['run.running','run.healthEnabled','run.windowStartedAt','generation == epoch','job?.cancel()']) assert.ok(s.includes(field));
 assert.ok(s.indexOf('queue.save(') < s.indexOf('RabiWearableHealthClient().publish('));
});
test('settings delegates health requests to sole owner', () => {
 const s = read(root + 'WearableHealthSettingsActivity.kt');
 assert.match(s, /RabiConversationService.syncHealth\(this\)/);
 assert.doesNotMatch(s, /WearableHealthSyncService\./);
 assert.doesNotMatch(s, /enabled = startAfterSave && problem/);
});
for (const p of ['apps/rabi-mobile-android/scripts/Sync-MiHealthWearableToRabiLink.ps1','plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/resources/Sync-MiHealthWearableToRabiLink.ps1']) {
 test(`companion enforces persistent current window: ${p}`, () => {
 const s = read(p);
 assert.match(s, /shared_prefs\/rabi_all_day_recording.xml/);
 assert.match(s, /\$values.running -ne "true" -or \$values.healthEnabled -ne "true"/);
 assert.ok(s.indexOf('$script:PermitWindowStartedAt = Get-RabiLinkMobileRunPermit') < s.indexOf('$heartRate = Get-MiHealthLatestHeartRate'));
 assert.match(s, /\(Get-RabiLinkMobileRunPermit\) -ne \$script:PermitWindowStartedAt/);
 assert.match(s, /\$start -ge \$script:RunWindowStartedAt/);
 });
}

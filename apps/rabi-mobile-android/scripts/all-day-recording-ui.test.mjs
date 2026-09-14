import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = new URL('../app/src/main/java/com/rabi/link/', import.meta.url);
const hub = readFileSync(new URL('recording/RabiRecordingHubActivity.kt', base), 'utf8');
const main = readFileSync(new URL('MainActivity.kt', base), 'utf8');
const store = readFileSync(new URL('recording/RecordingStore.kt', base), 'utf8');
const identity = readFileSync(new URL('recording/TargetWorkerIdentity.java', base), 'utf8');

test('recording UI delegates capture to the sole owner, never binds retired services', () => {
  for (const action of ['startRecording', 'pauseRecording', 'syncHealth', 'markRecording', 'currentVideo'])
    assert.match(hub, new RegExp(`RabiConversationService\\.${action}\\(`));
  assert.doesNotMatch(hub + main, /RabiLocalAudioService|RabiLiveRecordingService|bindService\(/);
  assert.match(hub, /live\?\.unlisten\(videoChanged\)/);
  assert.match(hub, /RECEIVER_NOT_EXPORTED/);
});
test('recording intent is explicit and independent of chat target and running', () => {
  assert.match(hub, /listOf\("audio", "video", "health"\)/);
  assert.match(hub, /listOf\("mobile", "glasses"\)/);
  assert.match(hub, /listOf\("local_only", "transcribe", "agent"\)/);
  assert.match(hub, /AllDayRecordingSettings\(false,/);
  assert.match(hub, /previous\.routeProfileId/);
  assert.doesNotMatch(hub, /RabiConversationTarget/);
  assert.match(hub, /health\.isChecked/);
  assert.match(hub, /upload\.isChecked/);
});
test('unbound capture is allowed, source permissions are scoped and terminal errors remain visible', () => {
  assert.doesNotMatch(hub, /请选择固定处理目标，或改为仅本地保存|请先设置固定处理目标/);
  assert.match(hub, /已有记录不会自动补绑/);
  assert.match(hub, /value\.mode == "audio" && value\.source == "mobile"\) required\.add\(Manifest\.permission\.RECORD_AUDIO\)/);
  assert.match(hub, /BLUETOOTH_CONNECT/);
  assert.match(hub, /BLUETOOTH_SCAN/);
  assert.match(hub, /POST_NOTIFICATIONS/);
  assert.doesNotMatch(hub, /ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION/);
  assert.match(hub, /actualStatus\.ifBlank/);
  assert.match(hub, /时间戳不表示设备当前在线/);
});
test('opening chat cannot restore legacy microphone or automatic video flags', () => {
  assert.doesNotMatch(main, /restoreAfterBoot|RabiConversationStartupPolicy|auto_start_video|startRecording\(|requestPhoneAudio|autoStartVoiceService/);
  assert.doesNotMatch(main, /RokidDeviceStatusSyncService\.start/);
  assert.match(main, /RabiConversationService\.start\(this\)/);
  assert.match(main, /保存设置（不启动采集）/);
});
test('target worker identity is scoped by credential digest and saved after server verification', () => {
  assert.match(identity, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(identity, /edit\.putString\(key, id\)/);
  assert.doesNotMatch(identity, /putString\([^\n]*token/);
  assert.match(main, /check\(state\.selectedWorker\?\.id == pc\.id\)/);
  assert.match(main, /TargetWorkerIdentity\.save\(this, url, token, state\.selectedWorker\?\.id\.orEmpty\(\)\)/);
});
test('navigation, evidence and archival provenance remain explicit', () => {
  for (const text of ['"home" to "记录"', '"records" to "时间线"', '"messages" to "消息"', '"devices" to "设备"']) {
    assert.ok(hub.includes(text)); assert.ok(main.includes(text));
  }
  assert.match(hub, /captureLastReceivedAt/);
  assert.match(hub, /healthLastReceivedAt/);
  assert.match(hub, /尚无实际样本证据/);
  assert.match(hub, /不代表新全天记录已经完成转写/);
  assert.match(hub, /listCaptureRecords\(this, 100\)/);
  assert.match(hub, /exportCaptureWave\(this, id\)/);
  assert.match(store, /fun listMarkers\(\)/);
  assert.doesNotMatch(store, /\.delete\(|deleteRecursively/);
});

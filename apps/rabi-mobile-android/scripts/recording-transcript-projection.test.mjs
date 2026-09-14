import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root = new URL('../app/src/main/java/com/rabi/link/recording/', import.meta.url);
const client = readFileSync(new URL('RecordingTranscriptProjection.kt',root),'utf8');
const hub = readFileSync(new URL('RabiRecordingHubActivity.kt',root),'utf8');
test('readonly queries require worker fence and isolate credentials, worker, stable device',()=>{
 assert.match(client,/TargetWorkerIdentity\.load/);
 assert.match(client,/config\.baseUrl\.trimEnd\('\/'\), config\.token, worker, device/);
 assert.match(client,/SHA-256/);
 assert.match(client,/X-RabiLink-Expected-Worker-Id/);
 assert.match(client,/expectedWorkerFencing/);
 assert.match(client,/requestMethod = "GET"/);
 assert.match(client,/instanceFollowRedirects = false/);
 assert.match(client,/check\(isCurrent\(scope\)\)/);
});
test('records associate only captureId and processedAt is seconds, never old time',()=>{
 assert.match(client,/processedAt", 0\.0/);
 assert.match(client,/processed \* 1000/);
 assert.doesNotMatch(client,/optDouble\("time"/);
 assert.match(client,/if\(capture\.isEmpty\(\)\) \{ unassigned\+\+; continue \}/);
 assert.match(hub,/it\.captureId == captureId/);
 assert.match(hub,/处理于/);
});
test('cache is explicitly non-realtime, manually refreshed with no polling',()=>{
 assert.match(hub,/刷新转写（最近24小时）/);
 assert.match(hub,/缓存来源/);
 assert.match(hub,/非实时/);
 assert.match(hub,/projection\.cached/);
 assert.match(hub,/transcriptRefreshRunning/);
 assert.doesNotMatch(client,/postDelayed|scheduleAtFixedRate/);
 assert.match(client,/AtomicFile\(target\)/);
});

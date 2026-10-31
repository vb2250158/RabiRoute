import assert from "node:assert/strict";
import test from "node:test";
import { XiaomiHomeClipCaptureWorker, parseHlsMediaPlaylist } from "./clipCapture.js";
import type { XiaomiHomeArtifactStore } from "./artifactStore.js";

test("camera capture status exposes counts but not allowed host names", () => {
  const worker = new XiaomiHomeClipCaptureWorker({
    cameraClipCaptureEnabled: true,
    cameraClipAllowedHosts: ["media.private.local"]
  }, {} as XiaomiHomeArtifactStore);
  assert.deepEqual(worker.status(), {
    enabled: true,
    ready: true,
    allowedHostCount: 1,
    inFlight: 0
  });
  assert.equal(JSON.stringify(worker.status()).includes("media.private.local"), false);
});

test("parses an encrypted Xiaomi motion playlist with stable media sequence", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-MEDIA-SEQUENCE:41",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x0000000000000000000000000000002a",
    "#EXTINF:5.0,",
    "segment-1.ts",
    "#EXTINF:5.0,",
    "https://cdn.example/segment-2.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  const segments = parseHlsMediaPlaylist(playlist, new URL("https://media.example/event/index.m3u8"), ["media.example", "cdn.example"]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].sequence, 41);
  assert.equal(segments[1].sequence, 42);
  assert.equal(segments[0].key.method, "AES-128");
});

test("rejects media segments outside the explicit host allowlist", () => {
  assert.throws(() => parseHlsMediaPlaylist([
    "#EXTM3U",
    "#EXTINF:5.0,",
    "https://unexpected.example/segment.ts"
  ].join("\n"), new URL("https://media.example/event/index.m3u8"), ["media.example"]), /not allowed/);
});


test("camera clips have no implicit host restriction when the list is empty", () => {
  const worker = new XiaomiHomeClipCaptureWorker({ cameraClipCaptureEnabled: true }, {} as XiaomiHomeArtifactStore);
  assert.equal(worker.isEnabled(), true);
  const playlist = '#EXTM3U\n#EXTINF:5.0,\nhttp://new-cdn.example/segment.ts';
  assert.equal(parseHlsMediaPlaylist(playlist, new URL("https://media.example/index.m3u8"), []).length, 1);
});


test("explicit camera hosts also constrain redirect targets before fetching them", async () => {
  let calls = 0;
  const worker = new XiaomiHomeClipCaptureWorker({ cameraClipCaptureEnabled: true, cameraClipAllowedHosts: ["media.example"] },
    { getBySourceEventId: () => undefined } as unknown as XiaomiHomeArtifactStore,
    async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://other.example/clip.m3u8" } }); });
  await assert.rejects(worker.capture({ sourceEventId: "redirect-policy", resourceId: "home:ha:camera.example", resourceName: "Fixture", occurredAt: "2026-01-01T00:00:00Z", eventType: "PeopleMotion", playlistUrl: "http://media.example/clip.m3u8" }), /cameraClipAllowedHosts/);
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRecordingRequestScope, readLatestRecording, releaseRecordingVideo } from "../../../web/recordingsClient.js";

const revision = "xiaomi-settings:" + "a".repeat(32);
const identity = { applicationGenerationId: "generation-a", managerInstanceId: "manager-a" };
const artifact = { artifactId: "xiaomi-artifact-fixture", ownerRoleId: "RoleA", mediaKind: "video/mp4", occurredAt: "2026-11-08T00:00:00Z", byteLength: 123, durationMs: 1000 };

function responses(values: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    assert.ok(values.length, "Unexpected additional network request");
    return new Response(JSON.stringify(values.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

test("recording lookup fences metadata with current identity and builds only original relative Range URL", async () => {
  const fixture = responses([identity, { code: 0, data: { artifact: { ...artifact, mediaUrl: "https://foreign.invalid/video", localPath: "C:/private/video.mp4", token: "untrusted" }, settingsRevision: revision } }, identity]);
  const signal = new AbortController().signal;
  const result = await readLatestRecording(fixture.fetcher, revision, "RoleA", signal);
  assert.deepEqual(fixture.calls.map(call => call.url), ["/meta", "/api/agent/xiaomi-home/recordings/latest", "/meta"]);
  const request = fixture.calls[1]!.init!;
  assert.equal(request.signal, signal); assert.equal(request.redirect, "error");
  const headers = new Headers(request.headers);
  assert.equal(headers.get("x-rabiroute-expected-application-generation-id"), identity.applicationGenerationId);
  assert.equal(headers.get("x-rabiroute-expected-manager-instance-id"), identity.managerInstanceId);
  const media = new URL(result.mediaPath!, "http://manager.invalid");
  assert.equal(media.pathname, "/api/agent/xiaomi-home/artifacts/" + artifact.artifactId + "/content");
  assert.deepEqual(Object.fromEntries(media.searchParams), { expectedApplicationGenerationId: identity.applicationGenerationId, expectedManagerInstanceId: identity.managerInstanceId, settingsRevision: revision });
  assert.deepEqual(result.artifact, artifact);
  assert.ok(!JSON.stringify(result).includes("private")); assert.ok(!JSON.stringify(result).includes("foreign.invalid")); assert.ok(!JSON.stringify(result).includes("untrusted"));
});

test("empty current-role recording returns null after identity recheck without a content request", async () => {
  const fixture = responses([identity, { code: 0, data: { artifact: null, settingsRevision: revision } }, identity]);
  const result = await readLatestRecording(fixture.fetcher, revision, "RoleA", new AbortController().signal);
  assert.deepEqual(result, { artifact: null, settingsRevision: revision }); assert.equal(fixture.calls.length, 3);
});

for (const mismatch of ["revision", "role", "generation", "instance", "media-kind", "path-id"] as const) test("recording lookup rejects stale or foreign " + mismatch, async () => {
  const changed = { ...artifact, ...(mismatch === "role" ? { ownerRoleId: "RoleB" } : {}), ...(mismatch === "media-kind" ? { mediaKind: "image/jpeg" } : {}), ...(mismatch === "path-id" ? { artifactId: "../foreign" } : {}) };
  const fixture = responses([identity, { code: 0, data: { artifact: changed, settingsRevision: mismatch === "revision" ? "xiaomi-settings:" + "b".repeat(32) : revision } },
    { ...identity, ...(mismatch === "generation" ? { applicationGenerationId: "generation-b" } : {}), ...(mismatch === "instance" ? { managerInstanceId: "manager-b" } : {}) }]);
  await assert.rejects(readLatestRecording(fixture.fetcher, revision, "RoleA", new AbortController().signal));
  assert.ok(fixture.calls.every(call => !call.url.includes("/content")));
});

test("cancelling a lookup suppresses an unabortable late response and never opens content", async () => {
  const controller = new AbortController(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; await pending; return new Response(JSON.stringify(identity)); };
  const result = readLatestRecording(fetcher, revision, "RoleA", controller.signal);
  controller.abort(); release();
  await assert.rejects(result); assert.equal(calls, 1);
});

test("request ownership invalidates old responses across close and role A to B to A", () => {
  const scope = createRecordingRequestScope(), first = scope.begin(), second = scope.begin(), third = scope.begin();
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, true);
  assert.equal(first.isCurrent(), false); assert.equal(second.isCurrent(), false); assert.equal(third.isCurrent(), true);
  scope.cancel(); assert.equal(third.isCurrent(), false); assert.equal(third.signal.aborted, true);
});

test("closing playback pauses and removes the media source without downloading a Blob", () => {
  const actions: string[] = [];
  releaseRecordingVideo({ pause: () => { actions.push("pause"); }, removeAttribute: name => { actions.push("remove:" + name); }, load: () => { actions.push("load"); } });
  assert.deepEqual(actions, ["pause", "remove:src", "load"]);
  releaseRecordingVideo(null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createMediaServiceClient, MediaServiceChangedError } from "../src/pages/mediaServiceClient";
import { createSpeechControlClient } from "../src/speech/speechControlClient";

test("workspace requests, resources and events remain local while only compute carries the selected PC", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createMediaServiceClient(() => "compute-b", async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ id: "asset", online: true });
  });
  await client.request("/status");
  const file = new Blob(["reference"]);
  await client.request("/assets?kind=video", { method: "POST", body: file });
  await client.request("/projects/project-a", { method: "PUT", body: "draft" });
  await client.request("/jobs/same-id");
  assert.deepEqual(calls.map(call => call.url), [
    "/api/video/status?computeDeviceId=compute-b",
    "/api/video/assets?kind=video&computeDeviceId=compute-b",
    "/api/video/projects/project-a",
    "/api/video/jobs/same-id"
  ]);
  assert.equal(calls[1].init?.body, file);
});

test("A to B to A rejects late responses, including a body still being read", async () => {
  let target = "a", release!: (response: Response) => void;
  const client = createMediaServiceClient(() => target, () => new Promise(resolve => { release = resolve; }));
  const first = client.request("/status");
  target = "b"; client.invalidate(); target = "a"; client.invalidate();
  release(Response.json({ online: true }));
  await assert.rejects(first, MediaServiceChangedError);

  let bodyDone!: (body: unknown) => void;
  const bodyClient = createMediaServiceClient(() => target, async () => ({ ok: true, json: () => new Promise(resolve => { bodyDone = resolve; }) }) as Response);
  const body = bodyClient.request("/status");
  await new Promise(resolve => setImmediate(resolve));
  target = "b"; bodyClient.invalidate(); bodyDone({ online: true });
  await assert.rejects(body, MediaServiceChangedError);
});

test("remote failure never falls back to local initialization or replays a write", async () => {
  const calls: string[] = [];
  const client = createMediaServiceClient(() => "offline-compute", async url => {
    calls.push(String(url)); return Response.json({ error: "service unavailable" }, { status: 502 });
  });
  await assert.rejects(client.request("/jobs", { method: "POST", headers: { "Idempotency-Key": "original-operation" }, body: "parameters" }), /service unavailable/);
  assert.deepEqual(calls, ["/api/video/jobs?computeDeviceId=offline-compute"]);
});

test("audio model listing and synthesis share the media target without changing the speech selection", async () => {
  const paths: string[] = [];
  const client = createMediaServiceClient(() => "compute-b", async url => {
    paths.push(String(url));
    return String(url).includes("/tts?") ? new Response(new Blob(["audio"], { type: "audio/wav" })) : Response.json({ code: 0, data: { models: [] } });
  });
  const speech = createSpeechControlClient((input, init) => client.fetchManager(String(input), init));
  assert.deepEqual(await speech.models(), { models: [] });
  const result = await speech.synthesize({ input: "hello", model: "fixture", play: false });
  assert.equal(await result.audio?.text(), "audio");
  assert.deepEqual(paths, ["/api/speech/models?computeDeviceId=compute-b", "/api/speech/tts?computeDeviceId=compute-b"]);
});

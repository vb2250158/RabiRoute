import assert from "node:assert/strict";
import test from "node:test";
import { localSpeechEndpoint, normalizeLocalSpeechServiceUrl, requestLocalSpeech } from "./localSpeechClient.js";

test("local speech URL accepts loopback only", () => {
  assert.equal(normalizeLocalSpeechServiceUrl("http://127.0.0.1:8781/"), "http://127.0.0.1:8781");
  assert.equal(localSpeechEndpoint("http://localhost:8781", "/v1/models"), "http://localhost:8781/v1/models");
  assert.throws(() => normalizeLocalSpeechServiceUrl("https://example.com"), /回环地址/);
  assert.throws(() => normalizeLocalSpeechServiceUrl("file:///tmp/speech"), /HTTP/);
});

test("local speech response exposes only allowlisted metadata", async () => {
  const fetchImpl: typeof fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "x-rabispeech-model": "gpt-sovits",
      "set-cookie": "secret=1"
    }
  });
  const response = await requestLocalSpeech("http://127.0.0.1:8781", "/v1/audio/speech", {}, { fetchImpl });
  assert.equal(response.contentType, "audio/wav");
  assert.equal(response.headers["x-rabispeech-model"], "gpt-sovits");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual([...response.body], [1, 2, 3]);
});

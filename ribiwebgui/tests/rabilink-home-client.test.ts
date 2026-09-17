import assert from "node:assert/strict";
import test from "node:test";
import { readRabiLinkHome, rabiLinkCapabilities } from "../src/rabiLinkHomeClient";
const device = { id: "example-pc", guid: "example-guid", name: "示例电脑", online: true, capabilities: ["asr", "future-cap"] };
const data = { devices: [device], checkedAt: "2026-01-01T00:00:00.000Z" };
function response(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}
test("home uses one fixed Manager GET without browser application credentials", async () => {
  const controller = new AbortController();
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "/api/rabi/link-home");
    assert.deepEqual(init, { method: "GET", cache: "no-store", signal: controller.signal });
    return new Response(JSON.stringify({ code: 0, data }));
  };
  assert.deepEqual(await readRabiLinkHome(controller.signal, request), data);
});
test("strict DTO parser rejects malformed success and upstream errors instead of zero devices", async () => {
  for (const body of [null, { code: -1 }, { code: 0, data: {} }, { code: 0, data: { ...data, checkedAt: "bad" } }, { code: 0, data: { ...data, devices: [{ ...device, online: "true" }] } }, { code: 0, data: { ...data, devices: [{ ...device, capabilities: [1] }] } }]) {
    await assert.rejects(readRabiLinkHome(new AbortController().signal, response(body)));
  }
  for (const status of [502, 503, 504]) {
    await assert.rejects(readRabiLinkHome(new AbortController().signal, response({ code: -1, message: "private raw upstream" }, status)), error => error instanceof Error && !error.message.includes("private raw"));
  }
  assert.deepEqual(await readRabiLinkHome(new AbortController().signal, response({ code: 0, data: { ...data, devices: [] } })), { ...data, devices: [] });
});
test("DTO projection discards unexpected credential and address fields", async () => {
  const result = await readRabiLinkHome(new AbortController().signal, response({ code: 0, data: { ...data, token: "fake-token", devices: [{ ...device, token: "fake-token", address: "private" }] } }));
  assert.deepEqual(result, data);
});
test("known service labels are Chinese and unknown capabilities stay in advanced details", () => {
  assert.deepEqual(rabiLinkCapabilities(["asr", "tts", "asr", "future-cap", "constructor", "__proto__"]), { known: ["语音识别", "语音合成"], advanced: ["future-cap", "constructor", "__proto__"] });
});

import assert from "node:assert/strict";
import test from "node:test";
import { publishedAutomaticWebhookUrl, publishedHttpCallbackUrl } from "../src/webhookRuntimeEndpoint";

const status = (updatedAt = "2026-11-08T00:00:01Z") => ({ running: true, pid: 123, startedAt: "2026-11-08T00:00:00Z",
  gatewayStatus: { pid: 123, gatewayGenerationId: "generation", messageAdapters: { webhook: { status: "running", updatedAt, listenerReady: true, listenerLeaseId: "lease", gatewayGenerationId: "generation" } },
    httpCallbacks: { webhook: { url: "http://127.0.0.1:45555/webhook" } } } });

test("both omitted and zero saved Webhook preferences expose the current native address", () => {
  for (const saved of [{}, { webhookPort: 0 }]) assert.equal(publishedAutomaticWebhookUrl(saved, status(), "/webhook"), "http://127.0.0.1:45555/webhook");
  assert.equal(publishedAutomaticWebhookUrl(null, status(), "/webhook"), "");
  assert.equal(publishedAutomaticWebhookUrl({ webhookPort: 45555 }, status(), "/webhook"), "");
});

test("published addresses retire immediately while accepted callbacks are still draining", () => {
  const runtime = status(); runtime.gatewayStatus.messageAdapters.webhook.listenerReady = false;
  assert.equal(publishedAutomaticWebhookUrl({}, runtime, "/webhook"), "");
  runtime.gatewayStatus.messageAdapters.webhook.listenerReady = true;
  runtime.gatewayStatus.gatewayGenerationId = "other";
  assert.equal(publishedAutomaticWebhookUrl({}, runtime, "/webhook"), "");
});

test("named HTTP callbacks expose actual ports and enforce the current owner and selected path", () => {
  for (const type of ["rabilink", "feishu"] as const) {
    const base = status();
    const runtime = { ...base, gatewayStatus: { ...base.gatewayStatus,
      messageAdapters: { [type]: base.gatewayStatus.messageAdapters.webhook },
      httpCallbacks: { [type]: { url: `http://127.0.0.1:45555/${type}` } } } };
    assert.equal(publishedHttpCallbackUrl(runtime, type, `/${type}`), `http://127.0.0.1:45555/${type}`);
    assert.equal(publishedHttpCallbackUrl(runtime, type, "/changed"), "");
    assert.equal(publishedHttpCallbackUrl({ ...runtime, pid: 456 }, type, `/${type}`), "");
    runtime.gatewayStatus.messageAdapters[type].listenerReady = false;
    assert.equal(publishedHttpCallbackUrl(runtime, type, `/${type}`), "");
  }
});
test("automatic addresses reject old generations, stopped listeners and unsaved paths", () => {
  assert.equal(publishedAutomaticWebhookUrl({}, status("2026-11-07T23:59:59Z"), "/webhook"), "");
  assert.equal(publishedAutomaticWebhookUrl({}, { ...status(), running: false }, "/webhook"), "");
  assert.equal(publishedAutomaticWebhookUrl({}, { ...status(), startedAt: undefined }, "/webhook"), "");
  assert.equal(publishedAutomaticWebhookUrl({}, status(), "/changed"), "");
});
test("published callback must be a usable credential-free loopback address", () => {
  for (const url of ["http://127.0.0.1:0/webhook", "http://example.com:45555/webhook", "http://user:secret@127.0.0.1:45555/webhook", "http://127.0.0.1:45555/webhook?token=hidden"]) {
    const runtime = status(); runtime.gatewayStatus.httpCallbacks.webhook.url = url;
    assert.equal(publishedAutomaticWebhookUrl({}, runtime, "/webhook"), "");
  }
});

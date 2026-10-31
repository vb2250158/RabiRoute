import assert from "node:assert/strict";
import test from "node:test";
import { scanWebhookEndpoint, type WebhookLikeScanContext } from "./webhookLikeScans.js";

function context(overrides: Partial<WebhookLikeScanContext<object>> = {}): WebhookLikeScanContext<object> {
  return { rootDir: process.cwd(), adapterRuntimes: () => [], routeCallbackEndpoint: () => null,
    routeHasRecentMessages: () => false, checkHttpEndpoint: async () => false, ...overrides };
}

test("generic webhook scan uses callback evidence without probing retired voice endpoints", async () => {
  let probes = 0;
  const result = await scanWebhookEndpoint(context({ checkHttpEndpoint: async () => { probes++; return true; } }));
  assert.equal(probes, 0);
  assert.equal(result.installed, false);
  assert.deepEqual(result.endpoints, []);
  assert.doesNotMatch(JSON.stringify(result), /FenneNote|FENNOTE|OumuQ/);
});

test("generic webhook scan publishes only the registered callback", async () => {
  const endpoint = { label: "callback", url: "http://example.invalid/webhook", healthy: true };
  const result = await scanWebhookEndpoint(context({ adapterRuntimes: () => [{}], routeCallbackEndpoint: () => endpoint }));
  assert.equal(result.installed, true);
  assert.deepEqual(result.endpoints, [endpoint]);
});

test("generic webhook scan preserves unknown history until any route has evidence", async () => {
  const first = {}, second = {};
  for (const [known, expected] of [[false, undefined], [true, true]] as const) {
    const result = await scanWebhookEndpoint(context({ adapterRuntimes: () => [first, second],
      routeHasRecentMessages: runtime => runtime === first ? undefined : known }));
    assert.equal(result.requirements?.find(item => item.id === "sender")?.ok, expected);
  }
});

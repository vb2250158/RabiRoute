import assert from "node:assert/strict";
import test from "node:test";
import { scanFenneNoteEndpoint, type WebhookLikeScanContext } from "./webhookLikeScans.js";

function context(overrides: Partial<WebhookLikeScanContext<object>> = {}): WebhookLikeScanContext<object> {
  return {
    rootDir: process.cwd(),
    adapterRuntimes: () => [],
    routeCallbackEndpoint: () => null,
    routeHasRecentMessages: () => false,
    checkHttpEndpoint: async () => false,
    fenneNotePlaybackUrl: "",
    ...overrides
  };
}

test("FenneNote scan does not probe or publish an empty compatibility endpoint", async () => {
  let probes = 0;
  const result = await scanFenneNoteEndpoint(context({
    fenneNotePlaybackUrl: "  ",
    checkHttpEndpoint: async () => {
      probes += 1;
      return true;
    }
  }));

  assert.equal(probes, 0);
  assert.equal(result.installed, false);
  assert.deepEqual(result.endpoints, []);
  const app = result.requirements?.find((requirement) => requirement.id === "app");
  assert.equal(app?.ok, false);
  assert.match(app?.detail ?? "", /FENNOTE_PLAYBACK_URL/);
});

test("FenneNote scan probes only the explicitly configured endpoint", async () => {
  const checked: string[] = [];
  const result = await scanFenneNoteEndpoint(context({
    fenneNotePlaybackUrl: "  http://fennenote.invalid/playback  ",
    checkHttpEndpoint: async (url) => {
      checked.push(url);
      return true;
    }
  }));

  assert.deepEqual(checked, ["http://fennenote.invalid/playback"]);
  assert.equal(result.installed, true);
  assert.deepEqual(result.endpoints, [{
    label: "FenneNote 播放/回复端",
    url: "http://fennenote.invalid/playback",
    healthy: true
  }]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { isNapcatPortSetting, publishedNapcatWsUrl } from "../src/napcatRuntimeEndpoint";

const status = () => ({ running: true, pid: 123, startedAt: "2026-11-08T00:00:00Z", gatewayStatus: {
  pid: 123, updatedAt: "2026-11-08T00:00:02Z", gatewayGenerationId: "current-generation",
  messageAdapters: { napcat: { status: "running", updatedAt: "2026-11-08T00:00:02Z" } },
  napcatInstances: { bot: { gatewayPort: 31415, listenerReady: true, listenerLeaseId: "lease-a", gatewayGenerationId: "current-generation", updatedAt: "2026-11-08T00:00:02Z", connected: false } }
} });

test("a live native listener exposes its actual WS address before QQ signs in", () => {
  assert.equal(publishedNapcatWsUrl(status(), "bot"), "ws://127.0.0.1:31415");
  assert.equal(publishedNapcatWsUrl(status(), "other-instance"), "");
  assert.equal(publishedNapcatWsUrl(status(), "bot", false), "");
});
test("a positive diagnostic port cannot become an address after publication is withdrawn", () => {
  const runtime = status(); runtime.gatewayStatus.napcatInstances.bot.listenerReady = false;
  assert.equal(publishedNapcatWsUrl(runtime, "bot"), "");
  runtime.gatewayStatus.napcatInstances.bot.listenerReady = true; runtime.running = false;
  assert.equal(publishedNapcatWsUrl(runtime, "bot"), "");
});
test("stale process, generation and publication snapshots never expose a connection target", () => {
  for (const change of [
    (runtime: ReturnType<typeof status>) => { runtime.pid = 456; },
    (runtime: ReturnType<typeof status>) => { runtime.startedAt = "2026-11-08T00:00:03Z"; },
    (runtime: ReturnType<typeof status>) => { runtime.gatewayStatus.napcatInstances.bot.updatedAt = "2026-11-07T23:59:59Z"; },
    (runtime: ReturnType<typeof status>) => { runtime.gatewayStatus.napcatInstances.bot.gatewayGenerationId = "old-generation"; },
    (runtime: ReturnType<typeof status>) => { runtime.gatewayStatus.gatewayGenerationId = ""; },
    (runtime: ReturnType<typeof status>) => { runtime.gatewayStatus.napcatInstances.bot.listenerLeaseId = ""; },
    (runtime: ReturnType<typeof status>) => { runtime.gatewayStatus.napcatInstances.bot.gatewayPort = 0; }
  ]) { const runtime = status(); change(runtime); assert.equal(publishedNapcatWsUrl(runtime, "bot"), ""); }
});
test("automatic settings accept zero while invalid configured port values remain invalid", () => {
  for (const port of [0, 1, 65535]) assert.equal(isNapcatPortSetting(port), true);
  for (const port of [-1, 65536, 0.5, NaN, "invalid"]) assert.equal(isNapcatPortSetting(port), false);
});

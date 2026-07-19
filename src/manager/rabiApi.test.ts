import assert from "node:assert/strict";
import test from "node:test";
import { publicRabiLinkRelayConfig } from "./rabiApi.js";

test("public Rabi identity never exposes the Relay application token", () => {
  const publicConfig = publicRabiLinkRelayConfig({
    enabled: true,
    url: "https://relay.example.test",
    token: "secret-app-token",
    deviceId: "pc-test",
    claimWaitMs: 60_000,
    replyIdleTimeoutMs: 60_000,
    speechProxyEnabled: false,
    speechServiceUrl: "http://127.0.0.1:8781"
  });

  assert.equal("token" in publicConfig, false);
  assert.equal(publicConfig.tokenConfigured, true);
  assert.equal(JSON.stringify(publicConfig).includes("secret-app-token"), false);
});

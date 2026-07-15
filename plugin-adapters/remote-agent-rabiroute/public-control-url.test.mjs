import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicControlUrl } from "./public-control-url.mjs";

test("public control URL accepts strict ws and wss endpoints", () => {
  assert.equal(normalizePublicControlUrl("wss://agent.example.com/api/remote-agent/control"), "wss://agent.example.com/api/remote-agent/control");
  assert.equal(normalizePublicControlUrl("ws://10.0.0.8:8797/api/remote-agent/control"), "ws://10.0.0.8:8797/api/remote-agent/control");
  assert.equal(normalizePublicControlUrl(""), "");
});

test("public control URL rejects credentials, queries, fragments, and non-WebSocket schemes", () => {
  for (const value of [
    "https://agent.example.com/api/remote-agent/control",
    "wss://user:secret@agent.example.com/api/remote-agent/control",
    "wss://agent.example.com/api/remote-agent/control?token=secret",
    "wss://agent.example.com/api/remote-agent/control#fragment",
    "wss://agent.example.com/other"
  ]) {
    assert.throws(() => normalizePublicControlUrl(value), /REMOTE_AGENT_PUBLIC_CONTROL_URL/);
  }
});

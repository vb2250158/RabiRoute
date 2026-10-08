import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

test("connection identity cannot be supplied in headers and unlocks existing settings after authentication", () => {
  const request = { socket: { remoteAddress: "192.0.2.10" }, headers: { authorization: "Bearer forged", "x-rabilink-tunnel-local": "forged", host: "example.invalid" } } as unknown as IncomingMessage;
  assert.equal(hasAuthenticatedConnectionRequest(request), false);
  assert.equal(localModelSettingsRequestAllowed(request), false);
  markAuthenticatedConnectionRequest(request);
  assert.equal(localModelSettingsRequestAllowed(request), true);
  assert.equal(hasAuthenticatedConnectionRequest({ ...request }), false);
});

test("registered Agent identity reuses connection access without a second grant", () => {
  const request = { socket: { remoteAddress: "192.0.2.10" }, headers: {} } as unknown as IncomingMessage;
  setTrustedLanAgentSource(request, { nodeId: "node", agentId: "agent", provider: "codex", sessionId: "session", sessionName: "Session" });
  assert.equal(localModelSettingsRequestAllowed(request), true);
});

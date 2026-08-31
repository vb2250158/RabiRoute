import assert from "node:assert/strict";
import test from "node:test";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import { parseIsolatedPluginRequest, parseIsolatedPluginResponse } from "./protocol.js";

const identity: PluginIdentity = Object.freeze({
  applicationGenerationId: "app-one",
  managerInstanceId: "manager-one",
  activationId: "activation-one",
  instanceId: "plugin-one",
  pluginId: "io.test.plugin",
  version: "1.0.0",
  revision: "revision-one",
  host: "manager"
});

test("isolated protocol decoders reject unknown fields and invalid request sequences", () => {
  const request = {
    protocolVersion: 1,
    requestId: "request-one",
    nonce: "nonce-one",
    sequence: 1,
    identity,
    command: "prepare",
    payload: { entryPath: "entry.mjs", config: {}, permissions: [], services: [] }
  };
  assert.equal(parseIsolatedPluginRequest(request).sequence, 1);
  assert.throws(() => parseIsolatedPluginRequest({ ...request, unexpected: true }), /unsupported fields/);
  assert.throws(() => parseIsolatedPluginRequest({ ...request, sequence: 0 }), /positive safe integer/);
  assert.throws(() => parseIsolatedPluginRequest({ ...request, identity: { ...identity, extra: true } }), /unsupported fields/);
  assert.throws(() => parseIsolatedPluginRequest({ ...request, command: "ping", payload: {} }), /must not include payload/);
});

test("isolated response decoder binds sequence and full identity", () => {
  const response = {
    protocolVersion: 1,
    requestId: "request-one",
    nonce: "nonce-one",
    sequence: 2,
    identity,
    ok: true,
    state: "committed"
  };
  assert.equal(parseIsolatedPluginResponse(response).identity.activationId, "activation-one");
  assert.throws(() => parseIsolatedPluginResponse({ ...response, sequence: "2" }), /positive safe integer/);
  assert.throws(() => parseIsolatedPluginResponse({ ...response, ok: false }), /must contain error/);
  assert.throws(() => parseIsolatedPluginResponse({ ...response, services: [{ capability: "x", value: 1, extra: true }] }), /unsupported fields/);
});

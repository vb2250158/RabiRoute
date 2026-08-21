import assert from "node:assert/strict";
import test from "node:test";
import {
  PROCESS_PLUGIN_PROTOCOL,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  encodeProcessPluginMessage,
  parseProcessPluginMessage,
  validateProcessPluginManifest,
  type ProcessPluginManifestMessage,
  type ProcessPluginRequestMessage
} from "./processPluginProtocol.js";

const contribution = {
  kind: "page" as const,
  id: "external.overview",
  label: { fallback: "External overview" },
  hosts: ["web"] as const,
  surface: "manager",
  slot: "main",
  routeId: "external-overview",
  rendererId: "manager.overview"
};

function manifestMessage(): ProcessPluginManifestMessage {
  return {
    protocol: PROCESS_PLUGIN_PROTOCOL,
    version: PROCESS_PLUGIN_PROTOCOL_VERSION,
    type: "manifest",
    manifest: {
      id: "package:manager/external-overview",
      name: "External overview",
      version: "1.2.3",
      kind: "external-process",
      hosts: ["manager"],
      capabilities: ["ui.contributions"]
    },
    contributions: [contribution]
  };
}

test("process plugin protocol encodes one versioned JSON line and parses it", () => {
  const message: ProcessPluginRequestMessage = {
    protocol: PROCESS_PLUGIN_PROTOCOL,
    version: PROCESS_PLUGIN_PROTOCOL_VERSION,
    type: "request",
    id: "request-1",
    method: "plugin.echo",
    params: { value: 7 }
  };

  const line = encodeProcessPluginMessage(message);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.deepEqual(parseProcessPluginMessage(line), message);
});

test("process plugin protocol validates external Manager manifests and normalizes contributions", () => {
  const validated = validateProcessPluginManifest(manifestMessage(), ["ui.contributions"]);

  assert.equal(validated.manifest.kind, "external-process");
  assert.deepEqual(validated.grantedCapabilities, ["ui.contributions"]);
  assert.deepEqual(validated.contributions, [{ ...contribution, label: { key: undefined, fallback: "External overview" } }]);
  assert.notEqual(validated.contributions, manifestMessage().contributions);
});

test("process plugin protocol rejects unsupported or denied capabilities", () => {
  const unsupported = manifestMessage();
  unsupported.manifest.capabilities = ["process.spawn"];
  assert.throws(
    () => validateProcessPluginManifest(unsupported, ["ui.contributions"]),
    /unsupported capability/i
  );

  assert.throws(
    () => validateProcessPluginManifest(manifestMessage(), []),
    /capability is not granted/i
  );
});

test("process plugin protocol rejects contributions without the contribution capability", () => {
  const message = manifestMessage();
  message.manifest.capabilities = [];

  assert.throws(
    () => validateProcessPluginManifest(message, []),
    /ui\.contributions capability/i
  );
});

test("process plugin protocol rejects code and resource fields in contribution declarations", () => {
  const message = manifestMessage() as ProcessPluginManifestMessage & {
    contributions: Array<Record<string, unknown>>;
  };
  message.contributions[0] = {
    ...message.contributions[0],
    componentPath: "C:\\private\\plugin.js",
    script: "run()"
  };

  assert.throws(
    () => validateProcessPluginManifest(message as ProcessPluginManifestMessage, ["ui.contributions"]),
    /unsupported field/i
  );
});

test("process plugin protocol rejects malformed JSON, wrong versions, and unknown message types", () => {
  assert.throws(() => parseProcessPluginMessage("{not-json}\n"), /invalid JSON/i);
  assert.throws(
    () => parseProcessPluginMessage(JSON.stringify({
      protocol: PROCESS_PLUGIN_PROTOCOL,
      version: 99,
      type: "health",
      id: "health-1"
    })),
    /unsupported protocol version/i
  );
  assert.throws(
    () => parseProcessPluginMessage(JSON.stringify({
      protocol: PROCESS_PLUGIN_PROTOCOL,
      version: PROCESS_PLUGIN_PROTOCOL_VERSION,
      type: "load-code",
      path: "plugin.js"
    })),
    /unsupported message type/i
  );
});

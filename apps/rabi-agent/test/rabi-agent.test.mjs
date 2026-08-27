import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { __test } from "../rabi-agent.mjs";

test("Rabi Agent turns Manager URLs into outbound WebSocket URLs", () => {
  assert.equal(__test.managerWebSocketUrl("http://192.168.1.10:8790"), "ws://192.168.1.10:8790/api/lan-agent/connect");
  assert.equal(__test.managerWebSocketUrl("https://manager.local/rabi/"), "wss://manager.local/rabi/api/lan-agent/connect");
});

test("Rabi Agent rejects unsafe package paths and compares Node versions", () => {
  assert.equal(__test.safeRelativePath("lib/cwd-policy.mjs"), "lib/cwd-policy.mjs");
  assert.throws(() => __test.safeRelativePath("../rabi-agent.mjs"), /Invalid/);
  assert.throws(() => __test.safeRelativePath("lib//worker.mjs"), /Invalid/);
  assert.equal(__test.versionAtLeast("22.0.0", "22.0.0"), true);
  assert.equal(__test.versionAtLeast("22.1.0", "22.0.1"), true);
  assert.equal(__test.versionAtLeast("21.9.0", "22.0.0"), false);
});


test("Rabi Agent rejects a manifest that replaces both the signing key and signature", () => {
  const trusted = generateKeyPairSync("ed25519");
  const replacement = generateKeyPairSync("ed25519");
  const makeManifest = pair => {
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest = {
      version: "0.1.0",
      platform: "node",
      minNodeVersion: "22.0.0",
      files: [{ path: "rabi-agent.mjs", sha256: "0".repeat(64), size: 1, downloadUrl: "/api/lan-agent/releases/0.1.0/node/rabi-agent.mjs" }],
      publicKey,
      publicKeySha256: __test.publicKeySha256(publicKey),
      signature: ""
    };
    manifest.signature = sign(null, Buffer.from(__test.manifestPayload(manifest)), pair.privateKey).toString("base64");
    return manifest;
  };
  const trustedManifest = makeManifest(trusted);
  const replacementManifest = makeManifest(replacement);
  const trustedFingerprint = trustedManifest.publicKeySha256;

  assert.equal(__test.verifyReleaseManifest(trustedManifest, trustedFingerprint), true);
  assert.equal(__test.verifyReleaseManifest(replacementManifest, trustedFingerprint), false);
});

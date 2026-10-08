import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeManagerApiClient, mapXiaomiHomeAction, normalizeHomeAssistantState, xiaomiHomeActionSatisfied } from "./managerApi.js";
import { normalizeXiaomiHomeRuntimeSettings } from "./settingsRuntime.js";
import { authorizeAgentApiOperation } from "../../manager/agentApiPolicy.js";

const binding = { mediaPlayerEntityId: "media_player.speaker", notifyEntityId: "notify.speaker_text", encoding: "json-array" as const };
const state = (entityId: string, features = 16384 | 1 | 4 | 8 | 32) => ({
  entity_id: entityId, state: entityId.startsWith("notify.") ? "unknown" : "on",
  attributes: { supported_features: features, "action params": "[Text(str)]" }, last_updated: "2026-10-01T00:00:00Z"
});
const action = (capability: string, args: Record<string, unknown> = {}) => ({ resourceId: "home:ha:media_player.speaker", capability, arguments: args, expectedStateVersion: "ha:before" });

test("media discovery reflects provider feature bits; arbitrary notify directives remain read-only", () => {
  assert.deepEqual(normalizeHomeAssistantState(state("media_player.speaker", 1 | 4)).capabilities,
    ["home.resource.read@1", "home.media.pause@1", "home.media.set_volume@1"]);
  assert.deepEqual(normalizeHomeAssistantState(state("notify.any_action")).capabilities, ["home.resource.read@1"]);
  assert.deepEqual(normalizeHomeAssistantState(state("media_player.speaker", 0)).capabilities, ["home.resource.read@1"]);
});

test("bounded typed arguments reject coercion, injection, unexpected fields and credential URLs", () => {
  for (const args of [{volume: null}, {volume: "0.5"}, {volume: true}, {volume: 1.1}, {volume: 0.2, entity_id: "other"}]) assert.throws(() => mapXiaomiHomeAction(action("home.media.set_volume@1", args)));
  for (const url of ["file:///private", "https://user:secret@example.org/a.mp3", "https://example.org/a?token=private", "https://example.org/a#private"]) assert.throws(() => mapXiaomiHomeAction(action("home.media.play_media@1", {url, mediaType: "music"})));
  assert.throws(() => mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "x".repeat(1001)}), [binding]));
  assert.throws(() => mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "hello"})));
  assert.throws(() => mapXiaomiHomeAction(action("home.media.play@1", JSON.parse('{"toString":"injected"}'))));
  assert.throws(() => mapXiaomiHomeAction({...action("home.media.play@1"), arguments: null as never}));
  const withoutVolume = normalizeHomeAssistantState(state("media_player.speaker"));
  withoutVolume.attributes.volume_level = null;
  assert.equal(xiaomiHomeActionSatisfied(action("home.media.set_volume@1", {volume: 0}), withoutVolume), false);
  assert.deepEqual(mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "yes\n\"hello\""}), [binding]).data,
    {entity_id: "notify.speaker_text", message: JSON.stringify(["yes\n\"hello\""])});
  assert.throws(() => mapXiaomiHomeAction({...action("home.speaker.speak@1", {text: "hello"}), resourceId: "home:ha:notify.any_action"}, [binding]));
});

test("bindings are explicit, unique, revisioned settings and have one owner", () => {
  const defaults = normalizeXiaomiHomeRuntimeSettings({});
  assert.deepEqual(defaults.speechBindings, []);
  assert.deepEqual(normalizeXiaomiHomeRuntimeSettings({...defaults, speechBindings: [binding]}).speechBindings, [binding]);
  for (const speechBindings of [[binding, binding], [{...binding, notifyEntityId: "switch.outlet"}], [{...binding, encoding: "raw-service"}], [{...binding, service: "execute"}]]) assert.throws(() => normalizeXiaomiHomeRuntimeSettings({...defaults, speechBindings}));
});

test("speech is accepted once, persists across client restart, is queryable offline and does not store text", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-"));
  let posts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/api/services/")) {
      posts++;
      assert.ok(String(input).endsWith("/notify/send_message"));
      assert.deepEqual(JSON.parse(String(init?.body)), {entity_id: binding.notifyEntityId, message: '["private utterance"]'});
      return new Response("[]");
    }
    return new Response(JSON.stringify(state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId)));
  };
  const config = {runtimeDir, writeEnabled: false, speechBindings: [binding]};
  try {
    const client = new XiaomiHomeManagerApiClient(config, fetchImpl, "private-token");
    const resource = await client.getResource("home:ha:media_player.speaker");
    const request = {...action("home.speaker.speak@1", {text: "private utterance"}), expectedStateVersion: resource.stateVersion};
    const [receipt, duplicate] = await Promise.all([client.executeAction(request, "speech-one"), client.executeAction(request, "speech-one")]);
    assert.equal(receipt.status, "accepted"); assert.equal(receipt.confirmation, "provider_acceptance"); assert.deepEqual(receipt, duplicate); assert.equal(posts, 1);
    const restarted = new XiaomiHomeManagerApiClient(config, async () => {throw new Error("offline");}, "private-token");
    assert.deepEqual(await restarted.executeAction(request, "speech-one"), receipt);
    assert.deepEqual(restarted.getActionReceipt("speech-one").receipt, receipt);
    assert.throws(() => restarted.getActionReceipt("not-found"), /No action receipt/);
    await assert.rejects(() => restarted.executeAction({...request, arguments: {text: "changed"}}, "speech-one"), /another action payload/);
    const files = fs.readdirSync(path.join(runtimeDir, "data/xiaomi-home-actions")).filter(name => name.endsWith(".json"));
    const stored = files.map(name => fs.readFileSync(path.join(runtimeDir, "data/xiaomi-home-actions", name), "utf8")).join("");
    assert.doesNotMatch(stored, /private utterance|private-token/);
  } finally { fs.rmSync(runtimeDir, {recursive: true, force: true}); }
});

test("unsupported, unavailable or changed speech parameter schemas never publish a POST; dry-run never speaks", async () => {
  for (const mode of ["unsupported", "unavailable", "schema", "dryRun"] as const) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-")); let posts = 0;
    try {
      const client = new XiaomiHomeManagerApiClient({runtimeDir, writeEnabled: true, speechBindings: [binding]}, async input => {
        if (String(input).includes("/api/services/")) { posts++; return new Response("[]"); }
        const current = state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId, mode === "unsupported" ? 0 : 16384);
        if (mode === "unavailable" && current.entity_id.startsWith("notify.")) current.state = "unavailable";
        if (mode === "schema") current.attributes["action params"] = "[Command(str), Execute(bool)]";
        return new Response(JSON.stringify(current));
      }, "test-token");
      const current = await client.getResource("home:ha:media_player.speaker");
      const request = mode === "unsupported" ? action("home.media.play@1") : action("home.speaker.speak@1", {text: "hello"});
      const receipt = await client.executeAction({...request, expectedStateVersion: current.stateVersion, dryRun: mode === "dryRun"}, `speech-${mode}`);
      assert.equal(receipt.status, mode === "dryRun" ? "planned" : "failed"); assert.equal(posts, 0);
    } finally {fs.rmSync(runtimeDir, {recursive: true, force: true});}
  }
});

test("lost speech POST response is uncertain across restart; state cannot prove audibility and recovery never resends", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-")); let posts = 0;
  const fake: typeof fetch = async input => {
    if (String(input).includes("/api/services/")) { posts++; throw new TypeError("lost private response"); }
    return new Response(JSON.stringify(state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId)));
  };
  try {
    const config = {runtimeDir, writeEnabled: true, speechBindings: [binding]};
    const client = new XiaomiHomeManagerApiClient(config, fake, "token");
    const current = await client.getResource("home:ha:media_player.speaker");
    const request = {...action("home.speaker.speak@1", {text: "hello"}), expectedStateVersion: current.stateVersion};
    await assert.rejects(() => client.executeAction(request, "speech-lost"), /uncertain/);
    assert.equal(client.getActionReceipt("speech-lost").state, "uncertain");
    await assert.rejects(() => new XiaomiHomeManagerApiClient(config, fake, "token").executeAction(request, "speech-lost"), /uncertain/);
    assert.equal(posts, 1);
  } finally {fs.rmSync(runtimeDir, {recursive: true, force: true});}
});

test("Agent entry catalog exposes capabilities and bounded receipt lookup but no settings or arbitrary services", () => {
  assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home/health").allowed, true);
  assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home/capabilities").allowed, true);
  assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home/resources/home%3Aha%3Amedia_player.speaker").allowed, true);
  assert.equal(authorizeAgentApiOperation("GET", "/api/roles/home%3Aha%3Amedia_player.speaker/plans").allowed, false);
  assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home/action-requests?idempotencyKey=speech-one").allowed, true);
  assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home/action-requests?idempotencyKey=x&idempotencyKey=y").allowed, false);
  assert.equal(authorizeAgentApiOperation("PUT", "/api/agent/xiaomi-home/settings").allowed, false);
  assert.equal(authorizeAgentApiOperation("POST", "/api/services/notify/send_message").allowed, false);
});

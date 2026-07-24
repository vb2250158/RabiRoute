import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { config, type RouteProfile } from "./config.js";
import { forwardMessageAndWait, shouldSkipHeartbeatDelivery } from "./forwarding.js";
import type { GroupMessageRecord, VoiceTranscriptEventRecord } from "./history.js";
import { ManagerSpeechControl } from "./manager/speechControl.js";
import { handleAgentReply } from "./outbox.js";
import { resolvePipeline } from "./pipelines.js";
import { readDeliveryReplayAttempts } from "./deliveryReplayLedger.js";
import { replayDeliveryAttempts } from "./deliveryReplay.js";
import { createSpeechIngressForwarding } from "./routing/speechIngressForwarding.js";
import { SpeechIngressStore } from "./speechIngressStore.js";

type ForwardingConfigPatch = Partial<Pick<typeof config,
  "agentAdapters"
  | "agentRoleFile"
  | "agentRoleId"
  | "dataDir"
  | "memoryDataDir"
  | "routeProfiles"
  | "rolesDir"
>>;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-forwarding-"));
}

function groupMessage(patch: Partial<GroupMessageRecord> = {}): GroupMessageRecord {
  return {
    time: 1710000000,
    groupId: 10001,
    userId: 42,
    rawMessage: "[CQ:at,qq=12345] hello",
    messageId: "msg-1",
    senderName: "Alice",
    ...patch
  };
}

function routeProfile(root: string, patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "main",
    name: "Main route",
    enabled: true,
    recentMessageLimit: 10,
    resolvedPipeline: resolvePipeline("qq_chat"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.join(root, "roles"),
    dataDir: path.join(root, "route-data"),
    routeVariables: {},
    notificationRules: [],
    ...patch
  };
}

test("heartbeat busy guard only skips active Codex heartbeat delivery", () => {
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["codex"], true), true);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", false, ["codex"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("private", true, ["codex"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["copilotCli"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["codex"], false), false);
});

async function withForwardingConfig<T>(patch: ForwardingConfigPatch, run: () => Promise<T> | T): Promise<T> {
  const previous: Required<ForwardingConfigPatch> = {
    agentAdapters: config.agentAdapters,
    agentRoleFile: config.agentRoleFile,
    agentRoleId: config.agentRoleId,
    dataDir: config.dataDir,
    memoryDataDir: config.memoryDataDir,
    routeProfiles: config.routeProfiles,
    rolesDir: config.rolesDir
  };
  Object.assign(config, patch);
  try {
    return await run();
  } finally {
    Object.assign(config, previous);
  }
}

test("forwardMessageAndWait returns missed when no route profile is active", async () => {
  const root = tempDir();
  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: []
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_active_route_profile");
    assert.equal(result.matchedRuleCount, 0);
    assert.equal(result.sentPacketCount, 0);
    assert.deepEqual(result.routes, []);
  });
});

test("forwardMessageAndWait returns route miss details when no rule matches", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("group_message", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_matching_rule");
    assert.equal(result.routes[0].routeId, "main");
    assert.equal(result.routes[0].status, "missed");
    assert.equal(result.routes[0].reason, "no_matching_rule");
    assert.deepEqual(result.routes[0].matchedRuleIds, []);
    assert.equal(result.sentPacketCount, 0);
  });
});

test("formal RabiSpeech hot delivery keeps filler transcripts while legacy voice sources stay filtered", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    notificationRules: [{
      id: "voice",
      name: "voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "voice={message}"
    }]
  });
  const speechRecord: VoiceTranscriptEventRecord = {
    time: 1710000000,
    rawMessage: "嗯",
    messageId: "speech-1",
    adapterType: "speech",
    source: "rabispeech",
    transport: "rabipc"
  };
  const legacyRecord: VoiceTranscriptEventRecord = {
    ...speechRecord,
    messageId: "legacy-1",
    adapterType: "fennenote",
    source: "fennenote",
    transport: "webhook"
  };

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: [route]
  }, async () => {
    const speechResult = await forwardMessageAndWait("voice_transcript", speechRecord);
    const legacyResult = await forwardMessageAndWait("voice_transcript", legacyRecord);

    assert.equal(speechResult.status, "routed");
    assert.equal(speechResult.reason, "no_agent_adapter");
    assert.equal(speechResult.sentPacketCount, 1);
    assert.deepEqual(speechResult.matchedRuleIds, ["voice"]);

    assert.equal(legacyResult.status, "skipped");
    assert.equal(legacyResult.reason, "low_signal_voice_transcript");
    assert.equal(legacyResult.sentPacketCount, 0);
  });
});

test("mobile message endpoint targets one selected route persona instead of broadcasting", async () => {
  const root = tempDir();
  const rule = { id: "mobile", name: "mobile", enabled: true, routeKinds: ["rabilink" as const], template: "{message}" };
  const rabi = routeProfile(root, { id: "Rabi", name: "Rabi", notificationRules: [rule] });
  const ilias = routeProfile(root, { id: "Ilias", name: "Ilias", agentRoleId: "Ilias", notificationRules: [rule] });
  const record: VoiceTranscriptEventRecord = {
    time: 1710000000, rawMessage: "hello Ilias", messageId: "mobile-1",
    adapterType: "rabilink", source: "rabilink-phone-chat", routeProfileId: "Ilias"
  };
  await withForwardingConfig({
    agentAdapters: [], dataDir: path.join(root, "data"), memoryDataDir: path.join(root, "memory"),
    routeProfiles: [rabi, ilias]
  }, async () => {
    const result = await forwardMessageAndWait("rabilink", record);
    assert.deepEqual(result.routes.map((route) => route.routeId), ["Ilias"]);
    assert.equal(result.sentPacketCount, 1);
  });
});

test("mobile PCM speech ingress reaches only its RabiLink persona with a stable reply device", async () => {
  const root = tempDir();
  const ingressStore = new SpeechIngressStore(path.join(root, "host-speech-ingress"));
  const mobileRoleDir = path.join(root, "roles", "Ilias");
  const voiceRoleDir = path.join(root, "roles", "Voice");
  const mobileRule = {
    id: "mobile-audio",
    name: "mobile audio",
    enabled: true,
    routeKinds: ["rabilink" as const],
    template: "{message}"
  };
  const mobileRoute = routeProfile(root, {
    id: "mobile-main",
    name: "Mobile main",
    agentRoleId: "Ilias",
    resolvedPipeline: resolvePipeline("agent"),
    notificationRules: [mobileRule]
  });
  const voiceRoute = routeProfile(root, {
    id: "voice-main",
    name: "Voice main",
    agentRoleId: "Voice",
    notificationRules: [{
      id: "host-voice",
      name: "host voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "{message}"
    }]
  });
  const managerRoutes = [
    { id: "VoiceRuntime", speechEnabled: true, rabiLinkEnabled: false, routeProfileIds: ["voice-main"] },
    { id: "MobileRuntime", speechEnabled: false, rabiLinkEnabled: true, routeProfileIds: ["mobile-main"] }
  ];
  const deliveredRuntimeRoutes: string[] = [];

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "gateway-data"),
    memoryDataDir: path.join(root, "host-history"),
    routeProfiles: [voiceRoute, mobileRoute],
    rolesDir: path.join(root, "roles")
  }, async () => {
    const control = new ManagerSpeechControl({
      serviceUrl: () => "http://127.0.0.1:8781",
      rolesRoot: () => path.join(root, "roles"),
      route: routeId => managerRoutes.find(route => route.id === routeId),
      routes: () => managerRoutes,
      deliverTranscript: async ({ routeId, record: ingress }) => {
        deliveredRuntimeRoutes.push(routeId);
        const forwarding = createSpeechIngressForwarding(ingress, {
          gatewayId: routeId,
          routeProfileId: ingress.routeProfileId
        });
        const result = await forwardMessageAndWait(forwarding.routeKind, forwarding.record);
        return result.sentPacketCount === 1
          ? { status: "delivered", reason: "test_agent_owner_accepted" }
          : { status: "failed", reason: result.reason || result.status };
      },
      appendRouteLog: () => {},
      speechIngressStore: ingressStore
    });

    const result = await control.acceptMessage({
      recordId: "mobile-audio-one",
      text: "从手机继续处理。",
      sessionId: "phone-session-one",
      messageAdapterType: "rabilink",
      routeProfileId: "mobile-main",
      source: "mobile_audio_stream",
      transport: "rabispeech_remote_audio",
      channelType: "rabilink.mobile_audio",
      sourceDeviceId: "phone-one",
      sourceDeviceName: "测试手机",
      sourceDeviceKind: "mobile",
      sourceStreamId: "phone-one-audio-stream-7",
      sourceHostId: "host-one",
      sourceHostName: "Studio PC",
      provider: "faster-whisper",
      model: "large-v3-turbo",
      language: "zh",
      sampleRate: 16_000,
      audioFormat: "pcm_s16le",
      channels: 1,
      peak: 0.42,
      rms: 0.18,
      startedAt: "2026-07-23T10:00:00.000Z",
      completedAt: "2026-07-23T10:00:02.000Z",
      ingestedAt: "2026-07-23T10:00:02.100Z",
      duration: 2,
      segments: [{
        id: 0,
        start: 0,
        end: 2,
        text: "从手机继续处理。",
        voiceprintId: "voiceprint-phone-speaker",
        speakerClusterId: "voiceprint-phone-speaker",
        speakerScore: 0.88,
        speakerDecision: "voiceprint_candidate",
        words: [{ word: "手机", start: 0.2, end: 0.5, probability: 0.93 }]
      }]
    });

    assert.equal(result.status, "delivered");
    assert.deepEqual(deliveredRuntimeRoutes, ["MobileRuntime"]);
    assert.equal(ingressStore.list().length, 1);
    assert.equal(fs.existsSync(path.join(voiceRoleDir, "voice-transcripts.jsonl")), false);

    const voiceRows = fs.readFileSync(path.join(mobileRoleDir, "voice-transcripts.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(voiceRows.length, 1);
    assert.equal(voiceRows[0].adapterType, "rabilink");
    assert.equal(voiceRows[0].sourceDeviceId, "phone-one");
    assert.equal(voiceRows[0].sourceStreamId, "phone-one-audio-stream-7");
    assert.equal(voiceRows[0].sourceHostId, "host-one");
    assert.equal(voiceRows[0].provider, "faster-whisper");
    assert.equal(voiceRows[0].rms, 0.18);
    assert.equal((voiceRows[0].segments as Array<Record<string, unknown>>)[0]?.voiceprintId, "voiceprint-phone-speaker");
    assert.equal(((voiceRows[0].segments as Array<Record<string, unknown>>)[0]?.words as Array<Record<string, unknown>>)[0]?.probability, 0.93);

    const conversationRows = fs.readFileSync(path.join(mobileRoleDir, "conversation", "current.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(conversationRows.length, 1);
    assert.equal(conversationRows[0].direction, "inbound");
    assert.equal(conversationRows[0].adapter, "rabilink");
    assert.equal(conversationRows[0].sourceDeviceId, "phone-one");
    assert.equal(conversationRows[0].sourceStreamId, "phone-one-audio-stream-7");
    assert.equal(conversationRows[0].rms, 0.18);

    const packetRows = fs.readFileSync(path.join(mobileRoleDir, "agent-packets.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as { text: string });
    assert.equal(packetRows.length, 1);
    assert.match(packetRows[0].text, /"sourceDeviceId":"phone-one"/);
    assert.match(packetRows[0].text, /"sourceStreamId":"phone-one-audio-stream-7"/);
    assert.match(packetRows[0].text, /"targetDeviceIds":\["phone-one"\]/);
    assert.doesNotMatch(packetRows[0].text, /"targetDeviceIds":\["phone-one-audio-stream-7"\]/);

    const contextMatch = packetRows[0].text.match(/当前回复上下文：(\{[^\r\n]+\})/);
    assert.ok(contextMatch?.[1]);
    const replyContext = JSON.parse(contextMatch[1]) as Record<string, unknown>;
    let relayBody: Record<string, unknown> = {};
    const relay = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        relayBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, status: "queued", messages: [{ id: "mobile-reply-one" }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = relay.address();
      assert.ok(address && typeof address === "object");
      const reply = await handleAgentReply({
        text: "已经从原手机继续处理。",
        replyContext
      }, {
        rootDir: root,
        routeRoot: path.join(root, "data", "route"),
        rolesRoot: path.join(root, "roles"),
        runtimes: [{
          id: "MobileRuntime",
          routeProfiles: [{ id: "mobile-main", agentRoleId: "Ilias" }],
          rabiLinkRelay: {
            enabled: true,
            url: `http://127.0.0.1:${address.port}`,
            token: "test-relay-token",
            deviceId: "host-one"
          },
          messageAdapterPolicies: {
            rabilink: { outputEnabled: true, supportedOutputs: ["text"] }
          }
        }]
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.status, "sent");
      assert.deepEqual(relayBody.targetDeviceIds, ["phone-one"]);
      assert.notDeepEqual(relayBody.targetDeviceIds, ["phone-one-audio-stream-7"]);
      assert.equal(relayBody.taskId, "mobile-audio-one");

      const repliedConversationRows = fs.readFileSync(path.join(mobileRoleDir, "conversation", "current.jsonl"), "utf8")
        .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(repliedConversationRows.length, 2);
      assert.deepEqual(repliedConversationRows.map(row => row.direction), ["inbound", "outbound"]);
      assert.equal(repliedConversationRows[1].adapter, "rabilink");
    } finally {
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  });
});

test("forwardMessageAndWait reports matched packets separately from adapter delivery", async () => {
  const root = tempDir();
  const routeDataDir = path.join(root, "roles", "Rabi");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: routeDataDir,
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "routed");
    assert.equal(result.reason, "no_agent_adapter");
    assert.deepEqual(result.matchedRuleIds, ["direct"]);
    assert.equal(result.sentPacketCount, 1);
    assert.deepEqual(result.adapterOutcomes, []);

    const packetLog = fs.readFileSync(path.join(routeDataDir, "agent-packets.jsonl"), "utf8");
    assert.match(packetLog, /matched/);
    assert.equal(fs.existsSync(path.join(routeDataDir, "codex-notifications.jsonl")), false);
  });
});

test("forwardMessageAndWait surfaces adapter delivery failures", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    dataDir: path.join(root, "route-data"),
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: ["unsupported" as AgentAdapterType],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "failed");
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.sentPacketCount, 1);
    assert.equal(result.adapterOutcomes.length, 1);
    assert.equal(result.adapterOutcomes[0].adapter, "unsupported");
    assert.equal(result.adapterOutcomes[0].status, "failed");
    assert.match(result.adapterOutcomes[0].error ?? "", /Unsupported agent adapter/);
  });
});

test("forwardMessageAndWait records replayable delivery attempts", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir,
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());
    const attempts = readDeliveryReplayAttempts(dataDir);

    assert.equal(result.status, "routed");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].routeKind, "direct_at");
    assert.equal(attempts[0].messageId, "msg-1");
    assert.equal(attempts[0].packets.length, 1);
    assert.match(attempts[0].packets[0].message, /matched/);
  });
});

test("replayDeliveryAttempts can merge failed attempts into one agent packet", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: ["unsupported" as AgentAdapterType],
    dataDir,
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    await forwardMessageAndWait("direct_at", groupMessage({ messageId: "msg-1", rawMessage: "[CQ:at,qq=12345] one" }));
    await forwardMessageAndWait("direct_at", groupMessage({ messageId: "msg-2", rawMessage: "[CQ:at,qq=12345] two" }));
    const failedAttempts = readDeliveryReplayAttempts(dataDir).filter((attempt) => attempt.result.status === "failed");

    const replay = await replayDeliveryAttempts(dataDir, {
      mode: "merge",
      attemptIds: failedAttempts.map((attempt) => attempt.attemptId)
    });

    assert.equal(replay.mode, "merge");
    assert.equal(replay.ok, false);
    assert.equal(replay.replayedAttemptIds.length, 2);
    assert.equal(replay.result?.sentPacketCount, 1);
    assert.match(replay.result?.adapterOutcomes[0].error ?? "", /Unsupported agent adapter/);
  });
});

test("replayDeliveryAttempts can backfill a stored message by route kind and message id", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const memoryDataDir = path.join(root, "route-data");
  fs.mkdirSync(memoryDataDir, { recursive: true });
  fs.appendFileSync(path.join(memoryDataDir, "private-messages.jsonl"), `${JSON.stringify({
    time: 1710000000,
    userId: 42,
    rawMessage: "old private message",
    messageId: "old-1",
    senderName: "Alice"
  })}\n`, "utf8");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "private",
      name: "private",
      enabled: true,
      routeKinds: ["private"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir,
    memoryDataDir,
    routeProfiles: [route]
  }, async () => {
    const replay = await replayDeliveryAttempts(dataDir, {
      routeKind: "private",
      messageId: "old-1"
    });

    assert.equal(replay.ok, true);
    assert.equal(replay.result?.status, "routed");
    assert.equal(replay.result?.sentPacketCount, 1);
    const attempts = readDeliveryReplayAttempts(dataDir);
    assert.equal(attempts.at(-1)?.replayOfAttemptId, "stored:private:old-1");
  });
});

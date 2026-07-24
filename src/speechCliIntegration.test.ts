import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSpeechProcessResult } from "./speechMessageDelivery.js";
import { SpeechIngressStore } from "./speechIngressStore.js";

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type SpeechCliFixture = {
  root: string;
  ingressDir: string;
  rolesDir: string;
  roleDir: string;
  ingressStore: SpeechIngressStore;
};

function runSpeechCli(args: string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src", "index.ts"), ...args], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`Speech CLI integration timed out. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr });
    });
  });
}

function createFixture(roleId: string): SpeechCliFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-cli-"));
  const ingressDir = path.join(root, "speech-messages");
  const rolesDir = path.join(root, "roles");
  const roleDir = path.join(rolesDir, roleId);
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), `# ${roleId}\n`, "utf8");
  return { root, ingressDir, rolesDir, roleDir, ingressStore: new SpeechIngressStore(ingressDir) };
}

function speechCliEnvironment(
  fixture: SpeechCliFixture,
  gatewayId: string,
  roleId: string,
  adapterType: "speech" | "rabilink",
  routeProfiles: unknown[]
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RABIROUTE_SPEECH_MESSAGES_DIR: fixture.ingressDir,
    GATEWAY_ID: gatewayId,
    GATEWAY_MANAGER_URL: "",
    MESSAGE_ADAPTER_TYPE: adapterType,
    MESSAGE_ADAPTER_TYPES: JSON.stringify([adapterType]),
    AGENT_ADAPTERS: "marvis",
    MARVIS_OPEN_ON_NOTIFY: "0",
    MARVIS_COPY_TO_CLIPBOARD: "0",
    ROLES_DIR: fixture.rolesDir,
    AGENT_ROLE_ID: roleId,
    AGENT_ROLE_FILE: "persona.md",
    DATA_DIR: path.join(fixture.root, "gateway-data"),
    ROUTE_PROFILES: JSON.stringify(routeProfiles)
  };
}

function replyContextForRole(roleDir: string): Record<string, unknown> {
  const packetRows = fs.readFileSync(path.join(roleDir, "agent-packets.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(packetRows.length, 1);
  const packet = JSON.parse(packetRows[0]) as { text: string };
  const contextMatch = packet.text.match(/当前回复上下文：(\{[^\r\n]+\})/);
  assert.ok(contextMatch?.[1]);
  return JSON.parse(contextMatch[1]) as Record<string, unknown>;
}

test("speech CLI reads the host record once and writes one RabiLink persona event", async () => {
  const fixture = createFixture("Ilias");
  fixture.ingressStore.append({
    recordId: "cli-mobile-one",
    text: "从真实子进程进入。",
    sessionId: "cli-phone-session",
    messageAdapterType: "rabilink",
    routeProfileId: "mobile-main",
    source: "mobile_audio_stream",
    transport: "rabispeech_remote_audio",
    channelType: "rabilink.mobile_audio",
    sourceDeviceId: "phone-cli",
    sourceDeviceKind: "mobile",
    sourceStreamId: "phone-cli-stream-9",
    sourceHostId: "host-cli",
    sourceHostName: "CLI host",
    provider: "faster-whisper",
    model: "large-v3-turbo",
    language: "zh",
    sampleRate: 16_000,
    audioFormat: "pcm_s16le",
    channels: 1,
    peak: 0.51,
    rms: 0.19,
    startedAt: "2026-07-23T12:00:00.000Z",
    completedAt: "2026-07-23T12:00:02.000Z",
    duration: 2,
    segments: [{
      id: 0,
      start: 0,
      end: 2,
      text: "从真实子进程进入。",
      voiceprintId: "voiceprint-cli",
      speakerClusterId: "voiceprint-cli"
    }]
  });

  const routeProfiles = [{
    id: "mobile-main",
    name: "Mobile main",
    enabled: true,
    recentMessageLimit: 10,
    pipelinePreset: "agent",
    agentRoleId: "Ilias",
    agentRoleFile: "persona.md",
    rolesDir: fixture.rolesDir,
    notificationRules: [{
      id: "mobile-audio",
      name: "Mobile audio",
      enabled: true,
      routeKinds: ["rabilink"],
      template: "{message}"
    }]
  }];
  const result = await runSpeechCli([
    "--speech-message=cli-mobile-one",
    "--speech-gateway=MobileRuntime",
    "--speech-route-profile=mobile-main"
  ], speechCliEnvironment(fixture, "MobileRuntime", "Ilias", "rabilink", routeProfiles));

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(parseSpeechProcessResult(result.stdout)?.status, "delivered");
  const voiceRows = fs.readFileSync(path.join(fixture.roleDir, "voice-transcripts.jsonl"), "utf8").trim().split(/\r?\n/);
  const conversationRows = fs.readFileSync(path.join(fixture.roleDir, "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(voiceRows.length, 1);
  assert.equal(conversationRows.length, 1);
  assert.equal((JSON.parse(voiceRows[0]) as { peak?: number }).peak, 0.51);
  assert.equal((JSON.parse(voiceRows[0]) as { rms?: number }).rms, 0.19);
  assert.equal((JSON.parse(conversationRows[0]) as { peak?: number }).peak, 0.51);
  assert.equal((JSON.parse(conversationRows[0]) as { rms?: number }).rms, 0.19);
  assert.equal(fixture.ingressStore.list().length, 1);
  const replyContext = replyContextForRole(fixture.roleDir);
  assert.equal(replyContext.targetType, "rabilink");
  assert.equal(replyContext.adapterType, "rabilink");
  assert.deepEqual(replyContext.targetDeviceIds, ["phone-cli"]);
  assert.notDeepEqual(replyContext.targetDeviceIds, ["phone-cli-stream-9"]);
});

test("speech CLI keeps the PC microphone on the independent voice endpoint", async () => {
  const fixture = createFixture("Rabi");
  fixture.ingressStore.append({
    recordId: "cli-pc-one",
    text: "这是电脑麦克风。",
    sessionId: "cli-pc-session",
    messageAdapterType: "speech",
    routeProfileId: "voice-main",
    source: "pc_microphone",
    transport: "rabispeech_local_audio",
    channelType: "speech.pc_microphone",
    sourceHostId: "host-cli",
    sourceHostName: "CLI host",
    provider: "faster-whisper",
    model: "large-v3-turbo",
    language: "zh",
    sampleRate: 16_000,
    audioFormat: "pcm_s16le",
    channels: 1,
    peak: 0.47,
    rms: 0.17,
    startedAt: "2026-07-23T12:10:00.000Z",
    completedAt: "2026-07-23T12:10:02.000Z",
    duration: 2,
    segments: [{
      id: 0,
      start: 0,
      end: 2,
      text: "这是电脑麦克风。",
      voiceprintId: "voiceprint-pc",
      speakerClusterId: "voiceprint-pc"
    }]
  });
  const routeProfiles = [{
    id: "voice-main",
    name: "Voice main",
    enabled: true,
    recentMessageLimit: 10,
    speechPushMode: "hot",
    pipelinePreset: "agent",
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: fixture.rolesDir,
    notificationRules: [{
      id: "host-voice",
      name: "Host voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "{message}"
    }]
  }];

  const result = await runSpeechCli([
    "--speech-message=cli-pc-one",
    "--speech-gateway=VoiceRuntime",
    "--speech-route-profile=voice-main"
  ], speechCliEnvironment(fixture, "VoiceRuntime", "Rabi", "speech", routeProfiles));

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(parseSpeechProcessResult(result.stdout)?.status, "delivered");
  assert.equal(fixture.ingressStore.list().length, 1);
  const voiceRows = fs.readFileSync(path.join(fixture.roleDir, "voice-transcripts.jsonl"), "utf8").trim().split(/\r?\n/);
  const conversationRows = fs.readFileSync(path.join(fixture.roleDir, "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(voiceRows.length, 1);
  assert.equal(conversationRows.length, 1);
  assert.equal((JSON.parse(voiceRows[0]) as { peak?: number }).peak, 0.47);
  assert.equal((JSON.parse(voiceRows[0]) as { rms?: number }).rms, 0.17);
  assert.equal((JSON.parse(conversationRows[0]) as { peak?: number }).peak, 0.47);
  assert.equal((JSON.parse(conversationRows[0]) as { rms?: number }).rms, 0.17);
  const replyContext = replyContextForRole(fixture.roleDir);
  assert.equal(replyContext.targetType, "voice_transcript");
  assert.equal(replyContext.adapterType, "speech");
  assert.equal(replyContext.targetDeviceIds, undefined);
  assert.equal(replyContext.sourceDeviceId, undefined);
  assert.equal(replyContext.sourceStreamId, undefined);
});

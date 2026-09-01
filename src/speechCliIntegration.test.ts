import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSpeechProcessResult } from "./speechMessageDelivery.js";
import { SpeechIngressStore } from "./speechIngressStore.js";
import type { RoleKnowledgeSnapshot } from "./roleKnowledge.js";
import { handleRoleContextProjectionRequest } from "./manager/roleContextProjection.js";

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

async function startRoleContextFixture(roleId: string, roleDir: string, gatewayId: string): Promise<{
  env: NodeJS.ProcessEnv;
  close: () => Promise<void>;
}> {
  const identity = { applicationGenerationId: "speech-test-generation", managerInstanceId: "speech-test-manager" };
  const capability = `speech-test-capability:${gatewayId}:${roleId}`;
  const projection: RoleKnowledgeSnapshot = {
    roleDir,
    plansDir: path.join(roleDir, "plans"),
    memoryDir: path.join(roleDir, "memory"),
    agentInterfaceDocPath: "docs/rabi-agent-interfaces.md",
    activePlans: [], activeSkills: [], recentMemories: [], matchedItems: [], matchedSkills: [], requiredReadItems: [],
    contextInjection: { mode: "focused", requiredReadLimit: 3, matchedItemLimit: 3, personaMaxChars: 1600 }
  };
  const readJsonBody = <T>(request: http.IncomingMessage): Promise<T> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
  const jsonResponse = (response: http.ServerResponse, statusCode: number, body: unknown): void => {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handleRoleContextProjectionRequest(request, url, response, {
      identity,
      isLoopback: () => true,
      verifyCapability: (actualGateway, actualRole, actualCapability) =>
        actualGateway === gatewayId && actualRole === roleId && actualCapability === capability,
      readJsonBody,
      resolve: body => body.roleId === roleId ? projection : undefined,
      requestRefresh: () => undefined,
      jsonResponse
    })) jsonResponse(response, 404, {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    env: {
      GATEWAY_MANAGER_URL: `http://127.0.0.1:${address.port}`,
      RABIROUTE_APPLICATION_GENERATION_ID: identity.applicationGenerationId,
      RABIROUTE_MANAGER_INSTANCE_ID: identity.managerInstanceId,
      PERSONA_MESSAGING_CAPABILITY: capability
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

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
    // Full-suite execution starts several source-mode TSX children in
    // parallel. A mapped NAS workspace can make their cold start approach two
    // minutes even though the CLI exits promptly once loaded.
    }, 120_000);
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
    GATEWAY_MANAGER_URL: process.env.GATEWAY_MANAGER_URL,
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
  const contextMatch = packet.text.match(/来源上下文（只用于核对来源，不可直接作为发送参数）：(\{[^\r\n]+\})/);
  assert.ok(contextMatch?.[1]);
  return JSON.parse(contextMatch[1]) as Record<string, unknown>;
}

test("speech CLI reads the host record once and writes one RabiLink persona event", async () => {
  const fixture = createFixture("Ilias");
  const completedAt = Date.now();
  fixture.ingressStore.append({
    recordId: "cli-mobile-one",
    text: "请从真实子进程进入。",
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
    startedAt: new Date(completedAt - 2_000).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    duration: 2,
    segments: [{
      id: 0,
      start: 0,
      end: 2,
      text: "请从真实子进程进入。",
      voiceprintId: "voiceprint-cli",
      speakerClusterId: "voiceprint-cli",
      speakerDecision: "voiceprint_auto_match",
      words: [{ word: "请从真实子进程进入", probability: 0.94 }]
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
  const roleContext = await startRoleContextFixture("Ilias", fixture.roleDir, "MobileRuntime");
  let result: ChildResult;
  try {
    result = await runSpeechCli([
      "--speech-message=cli-mobile-one",
      "--speech-gateway=MobileRuntime",
      "--speech-route-profile=mobile-main"
    ], { ...speechCliEnvironment(fixture, "MobileRuntime", "Ilias", "rabilink", routeProfiles), ...roleContext.env });
  } finally {
    await roleContext.close();
  }

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
  const completedAt = Date.now();
  fixture.ingressStore.append({
    recordId: "cli-pc-one",
    text: "请确认这是电脑麦克风。",
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
    startedAt: new Date(completedAt - 2_000).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    duration: 2,
    segments: [{
      id: 0,
      start: 0,
      end: 2,
      text: "请确认这是电脑麦克风。",
      voiceprintId: "voiceprint-pc",
      speakerClusterId: "voiceprint-pc",
      speakerDecision: "voiceprint_auto_match",
      words: [{ word: "请确认这是电脑麦克风", probability: 0.95 }]
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

  const roleContext = await startRoleContextFixture("Rabi", fixture.roleDir, "VoiceRuntime");
  let result: ChildResult;
  try {
    result = await runSpeechCli([
      "--speech-message=cli-pc-one",
      "--speech-gateway=VoiceRuntime",
      "--speech-route-profile=voice-main"
    ], { ...speechCliEnvironment(fixture, "VoiceRuntime", "Rabi", "speech", routeProfiles), ...roleContext.env });
  } finally {
    await roleContext.close();
  }

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

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpeechProcessResult } from "../speechMessageDelivery.js";
import { SpeechIngressStore } from "../speechIngressStore.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type SpeechIngressSeparationOptions = {
  outputPath?: string;
  entryPath?: string;
  entryArgsPrefix?: string[];
  timeoutMs?: number;
};

export type SpeechIngressSeparationDependencies = {
  now?: () => Date;
  tempRoot?: string;
};

function timestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function defaultOutputPath(now: Date): string {
  return path.join(REPO_ROOT, "data", "acceptance", `speech-ingress-separation-${timestamp(now)}.json`);
}

function atomicWriteJson(filePath: string, value: unknown): string {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function replyContext(roleDir: string): Record<string, unknown> {
  const packets = readJsonl(path.join(roleDir, "agent-packets.jsonl"));
  if (packets.length !== 1) throw new Error(`Expected exactly one isolated AgentPacket, received ${packets.length}.`);
  const text = String(packets[0]?.text || "");
  const match = text.match(/当前回复上下文：(\{[^\r\n]+\})/);
  if (!match?.[1]) throw new Error("Isolated AgentPacket did not contain replyContext.");
  const value = JSON.parse(match[1]) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid replyContext payload.");
  return value as Record<string, unknown>;
}

function runSpeechChild(
  entryPath: string,
  entryArgsPrefix: string[],
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...entryArgsPrefix, entryPath, ...args], {
      cwd: REPO_ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("Speech ingress separation child exceeded its one-shot deadline."));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.once("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr });
    });
  });
}

function routeProfile(
  id: string,
  roleId: string,
  rolesDir: string,
  routeKind: "voice_transcript" | "rabilink"
): Record<string, unknown> {
  return {
    id,
    name: id,
    enabled: true,
    recentMessageLimit: 10,
    speechPushMode: "hot",
    pipelinePreset: "agent",
    agentRoleId: roleId,
    agentRoleFile: "persona.md",
    rolesDir,
    notificationRules: [{
      id: `${id}-rule`,
      name: `${id}-rule`,
      enabled: true,
      routeKinds: [routeKind],
      template: "{message}"
    }]
  };
}

function speechEnvironment(
  root: string,
  ingressDir: string,
  rolesDir: string,
  gatewayId: string,
  roleId: string,
  adapterType: "speech" | "rabilink",
  profile: Record<string, unknown>
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RABIROUTE_SPEECH_MESSAGES_DIR: ingressDir,
    GATEWAY_ID: gatewayId,
    GATEWAY_MANAGER_URL: "",
    MESSAGE_ADAPTER_TYPE: adapterType,
    MESSAGE_ADAPTER_TYPES: JSON.stringify([adapterType]),
    AGENT_ADAPTERS: "marvis",
    MARVIS_OPEN_ON_NOTIFY: "0",
    MARVIS_COPY_TO_CLIPBOARD: "0",
    ROLES_DIR: rolesDir,
    AGENT_ROLE_ID: roleId,
    AGENT_ROLE_FILE: "persona.md",
    DATA_DIR: path.join(root, "gateway-data", gatewayId),
    ROUTE_PROFILES: JSON.stringify([profile])
  };
}

function hasFullHostEvidence(record: Record<string, unknown>): boolean {
  const segments = Array.isArray(record.segments) ? record.segments as Array<Record<string, unknown>> : [];
  return Boolean(
    oneLine(record.id)
    && oneLine(record.recordedAt)
    && oneLine(record.startedAt)
    && oneLine(record.completedAt)
    && oneLine(record.channelType)
    && oneLine(record.source)
    && oneLine(record.transport)
    && oneLine(record.provider)
    && oneLine(record.model)
    && oneLine(record.language)
    && Number(record.sampleRate) === 16_000
    && Number(record.channels) === 1
    && oneLine(record.audioFormat)
    && Number(record.duration) > 0
    && segments.length > 0
    && oneLine(segments[0]?.voiceprintId || segments[0]?.speakerClusterId)
  );
}

function containsHostIdentityLeak(rows: Array<Record<string, unknown>>): boolean {
  const serialized = JSON.stringify(rows);
  return ["Host Guess", "Host Candidate", "host-profile", "host-suggestion"].some(value => serialized.includes(value));
}

function check(id: string, passed: boolean, actual?: unknown): Record<string, unknown> {
  return { id, passed, ...(actual === undefined ? {} : { actual }) };
}

export async function runSpeechIngressSeparationAcceptance(
  options: SpeechIngressSeparationOptions = {},
  dependencies: SpeechIngressSeparationDependencies = {}
): Promise<{ report: Record<string, unknown>; evidencePath: string; exitCode: number }> {
  const now = dependencies.now?.() ?? new Date();
  const outputPath = options.outputPath || defaultOutputPath(now);
  const entryPath = path.resolve(options.entryPath || DEFAULT_ENTRY);
  const entryArgsPrefix = options.entryArgsPrefix ?? [];
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || 20_000));
  const fixtureRoot = fs.mkdtempSync(path.join(dependencies.tempRoot || os.tmpdir(), "rabiroute-speech-separation-"));
  const ingressDir = path.join(fixtureRoot, "speech-messages");
  const rolesDir = path.join(fixtureRoot, "roles");
  const pcRoleId = "AcceptancePcPersona";
  const mobileRoleId = "AcceptanceMobilePersona";
  const pcRoleDir = path.join(rolesDir, pcRoleId);
  const mobileRoleDir = path.join(rolesDir, mobileRoleId);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "speech_ingress_endpoint_separation_acceptance",
    generatedAt: now.toISOString(),
    status: "starting",
    acceptancePassed: false,
    isolatedFixture: true,
    externalDeliveryAttempted: false,
    checks: []
  };
  let exitCode = 1;
  try {
    if (!fs.existsSync(entryPath)) throw new Error("Speech acceptance entry is missing. Run npm run build:backend first.");
    fs.mkdirSync(pcRoleDir, { recursive: true });
    fs.mkdirSync(mobileRoleDir, { recursive: true });
    fs.writeFileSync(path.join(pcRoleDir, "persona.md"), "# PC acceptance persona\n", "utf8");
    fs.writeFileSync(path.join(mobileRoleDir, "persona.md"), "# Mobile acceptance persona\n", "utf8");
    const ingress = new SpeechIngressStore(ingressDir);
    ingress.append({
      recordId: "acceptance-pc-record",
      text: "PC microphone acceptance phrase.",
      sessionId: "acceptance-pc-session",
      messageAdapterType: "speech",
      routeProfileId: "acceptance-pc-route",
      source: "pc_microphone",
      transport: "rabispeech_local_audio",
      channelType: "speech.pc_microphone",
      sourceHostId: "acceptance-host",
      sourceHostName: "Acceptance host",
      provider: "acceptance-asr",
      model: "acceptance-model",
      language: "zh",
      sampleRate: 16_000,
      audioFormat: "pcm_s16le",
      channels: 1,
      startedAt: "2026-07-23T12:00:00.000Z",
      completedAt: "2026-07-23T12:00:02.000Z",
      duration: 2,
      segments: [{
        id: 0,
        start: 0,
        end: 2,
        text: "PC microphone acceptance phrase.",
        voiceprintId: "acceptance-pc-voiceprint",
        speakerClusterId: "acceptance-pc-voiceprint",
        speakerName: "Host Guess",
        speakerId: "host-profile",
        speakerSuggestionName: "Host Candidate",
        speakerSuggestionId: "host-suggestion"
      } as never]
    });
    ingress.append({
      recordId: "acceptance-mobile-record",
      text: "Mobile audio acceptance phrase.",
      sessionId: "acceptance-mobile-session",
      messageAdapterType: "rabilink",
      routeProfileId: "acceptance-mobile-route",
      source: "mobile_audio_stream",
      transport: "rabispeech_remote_audio",
      channelType: "rabilink.mobile_audio",
      sourceDeviceId: "acceptance-stable-device",
      sourceDeviceKind: "mobile",
      sourceStreamId: "acceptance-transient-stream",
      sourceHostId: "acceptance-host",
      sourceHostName: "Acceptance host",
      provider: "acceptance-asr",
      model: "acceptance-model",
      language: "zh",
      sampleRate: 16_000,
      audioFormat: "pcm_s16le",
      channels: 1,
      startedAt: "2026-07-23T12:10:00.000Z",
      completedAt: "2026-07-23T12:10:03.000Z",
      duration: 3,
      segments: [{
        id: 0,
        start: 0,
        end: 3,
        text: "Mobile audio acceptance phrase.",
        voiceprintId: "acceptance-mobile-voiceprint",
        speakerClusterId: "acceptance-mobile-voiceprint",
        speakerName: "Host Guess",
        speakerId: "host-profile",
        speakerSuggestionName: "Host Candidate",
        speakerSuggestionId: "host-suggestion"
      } as never]
    });

    const pcProfile = routeProfile("acceptance-pc-route", pcRoleId, rolesDir, "voice_transcript");
    const mobileProfile = routeProfile("acceptance-mobile-route", mobileRoleId, rolesDir, "rabilink");
    const [pcChild, mobileChild] = await Promise.all([
      runSpeechChild(
        entryPath,
        entryArgsPrefix,
        [
          "--speech-message=acceptance-pc-record",
          "--speech-gateway=AcceptancePcGateway",
          "--speech-route-profile=acceptance-pc-route"
        ],
        speechEnvironment(fixtureRoot, ingressDir, rolesDir, "AcceptancePcGateway", pcRoleId, "speech", pcProfile),
        timeoutMs
      ),
      runSpeechChild(
        entryPath,
        entryArgsPrefix,
        [
          "--speech-message=acceptance-mobile-record",
          "--speech-gateway=AcceptanceMobileGateway",
          "--speech-route-profile=acceptance-mobile-route"
        ],
        speechEnvironment(fixtureRoot, ingressDir, rolesDir, "AcceptanceMobileGateway", mobileRoleId, "rabilink", mobileProfile),
        timeoutMs
      )
    ]);
    const pcResult = parseSpeechProcessResult(pcChild.stdout);
    const mobileResult = parseSpeechProcessResult(mobileChild.stdout);
    const hostRecords = ingress.list(10) as unknown as Array<Record<string, unknown>>;
    const pcVoice = readJsonl(path.join(pcRoleDir, "voice-transcripts.jsonl"));
    const mobileVoice = readJsonl(path.join(mobileRoleDir, "voice-transcripts.jsonl"));
    const pcConversation = readJsonl(path.join(pcRoleDir, "conversation", "current.jsonl"));
    const mobileConversation = readJsonl(path.join(mobileRoleDir, "conversation", "current.jsonl"));
    const pcContext = replyContext(pcRoleDir);
    const mobileContext = replyContext(mobileRoleDir);
    const mobileTargets = Array.isArray(mobileContext.targetDeviceIds)
      ? mobileContext.targetDeviceIds.map(oneLine).filter(Boolean)
      : [];
    const endpointTypes = [...new Set(hostRecords.map(row => oneLine(row.messageAdapterType)).filter(Boolean))].sort();
    const identityLeak = containsHostIdentityLeak([
      ...hostRecords,
      ...pcVoice,
      ...mobileVoice,
      ...pcConversation,
      ...mobileConversation
    ]);
    const checks = [
      check("pc_cli_delivered", pcChild.code === 0 && pcResult?.status === "delivered", pcResult?.status || pcChild.code),
      check("mobile_cli_delivered", mobileChild.code === 0 && mobileResult?.status === "delivered", mobileResult?.status || mobileChild.code),
      check("one_host_store_two_records", hostRecords.length === 2, hostRecords.length),
      check("logical_endpoints_separated", endpointTypes.join(",") === "rabilink,speech", endpointTypes),
      check("host_records_keep_rich_evidence", hostRecords.every(hasFullHostEvidence)),
      check("pc_persona_voice_history_once", pcVoice.length === 1, pcVoice.length),
      check("mobile_persona_voice_history_once", mobileVoice.length === 1, mobileVoice.length),
      check("pc_persona_conversation_once", pcConversation.length === 1, pcConversation.length),
      check("mobile_persona_conversation_once", mobileConversation.length === 1, mobileConversation.length),
      check("host_identity_not_in_persona_context", !identityLeak),
      check("pc_reply_context_is_speech", pcContext.targetType === "voice_transcript" && pcContext.adapterType === "speech"),
      check("pc_has_no_mobile_reply_target", !Array.isArray(pcContext.targetDeviceIds) && !pcContext.sourceDeviceId && !pcContext.sourceStreamId),
      check("mobile_reply_context_is_rabilink", mobileContext.targetType === "rabilink" && mobileContext.adapterType === "rabilink"),
      check(
        "mobile_reply_uses_stable_device",
        mobileTargets.length === 1
          && mobileTargets[0] === "acceptance-stable-device"
          && mobileTargets[0] !== oneLine(mobileContext.sourceStreamId)
      )
    ];
    report.artifacts = {
      entrySha256: sha256(fs.readFileSync(entryPath)),
      entryKind: entryArgsPrefix.length ? "source" : "built"
    };
    report.counts = {
      hostRecords: hostRecords.length,
      pcVoiceHistory: pcVoice.length,
      mobileVoiceHistory: mobileVoice.length,
      pcConversation: pcConversation.length,
      mobileConversation: mobileConversation.length
    };
    report.endpoints = endpointTypes;
    report.replyContexts = {
      pc: { targetType: pcContext.targetType, adapterType: pcContext.adapterType, targetDeviceCount: 0 },
      mobile: {
        targetType: mobileContext.targetType,
        adapterType: mobileContext.adapterType,
        targetDeviceCount: mobileTargets.length,
        targetDeviceIdSha256: sha256(mobileTargets[0] || ""),
        sourceStreamIdSha256: sha256(oneLine(mobileContext.sourceStreamId))
      }
    };
    report.checks = checks;
    report.acceptancePassed = checks.every(item => item.passed === true);
    report.status = report.acceptancePassed ? "passed" : "checks_failed";
    exitCode = report.acceptancePassed ? 0 : 2;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message.replace(fixtureRoot, "<isolated-fixture>") : String(error);
    exitCode = 1;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  report.exitCode = exitCode;
  const evidencePath = atomicWriteJson(outputPath, report);
  return { report, evidencePath, exitCode };
}

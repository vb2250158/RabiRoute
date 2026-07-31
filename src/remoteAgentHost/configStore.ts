import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { normalizeAgentAdapters, type AgentAdapterType } from "../agentAdapters/types.js";
import { normalizeCodexHookSettings, type CodexHookSettings } from "../shared/gatewayConfigModel.js";

export type RemoteAgentProfile = {
  agentAdapters: AgentAdapterType[];
  agentModel?: string;
  codexThreadId?: string;
  codexThreadName?: string;
  codexCwd?: string;
  codexPlanAssistantSessions?: Array<{ id?: string; threadId?: string; threadName?: string; cwd?: string }>;
  codexHooks?: CodexHookSettings;
  copilotThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
};

export type RemoteAgentHostConfig = {
  schemaVersion: 1;
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  password: string;
  listenHost: string;
  port: number;
  discoveryPortStart: number;
  discoveryPortEnd: number;
  profile: RemoteAgentProfile;
};

export type RemoteAgentHostSettingsPatch = Partial<Pick<
  RemoteAgentHostConfig,
  "enabled" | "deviceName" | "password" | "listenHost" | "port" | "discoveryPortStart" | "discoveryPortEnd"
>> & {
  regeneratePassword?: boolean;
};

const profileKeys: Array<keyof RemoteAgentProfile> = [
  "agentAdapters",
  "agentModel",
  "codexThreadId",
  "codexThreadName",
  "codexCwd",
  "codexPlanAssistantSessions",
  "codexHooks",
  "copilotThreadName",
  "copilotCwd",
  "copilotCliBin",
  "marvisAppId",
  "astrbotUrl",
  "astrbotUsername",
  "astrbotPassword",
  "astrbotProjectId",
  "astrbotSessionId"
];

function validPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}
function generatedPassword(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeProfile(value: unknown): RemoteAgentProfile {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const profile: RemoteAgentProfile = {
    agentAdapters: normalizeAgentAdapters(Array.isArray(raw.agentAdapters) ? raw.agentAdapters : undefined),
    codexThreadName: String(raw.codexThreadName || "Remote Agent").trim() || "Remote Agent",
    codexCwd: String(raw.codexCwd || "").trim(),
    copilotThreadName: String(raw.copilotThreadName || "Remote Agent").trim() || "Remote Agent",
    copilotCwd: String(raw.copilotCwd || "").trim(),
    marvisAppId: String(raw.marvisAppId || "Tencent.Marvis").trim() || "Tencent.Marvis",
    astrbotUrl: String(raw.astrbotUrl || "http://127.0.0.1:6185").trim() || "http://127.0.0.1:6185",
    codexHooks: normalizeCodexHookSettings(raw.codexHooks)
  };
  for (const key of profileKeys) {
    if (profile[key] !== undefined || raw[key] === undefined) continue;
    (profile as Record<string, unknown>)[key] = raw[key];
  }
  return profile;
}

function defaultConfig(): RemoteAgentHostConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    deviceId: `rabi-agent-${randomUUID()}`,
    deviceName: os.hostname(),
    password: generatedPassword(),
    listenHost: "0.0.0.0",
    port: 8797,
    discoveryPortStart: 8798,
    discoveryPortEnd: 8818,
    profile: normalizeProfile(undefined)
  };
}

export class RemoteAgentHostConfigStore {
  readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  read(): RemoteAgentHostConfig {
    let raw: Partial<RemoteAgentHostConfig> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<RemoteAgentHostConfig>;
    } catch {
      // First launch has no setup wizard by design.
    }
    const fallback = defaultConfig();
    const password = String(raw.password || fallback.password);
    const config: RemoteAgentHostConfig = {
      schemaVersion: 1,
      enabled: raw.enabled !== false,
      deviceId: String(raw.deviceId || fallback.deviceId).trim() || fallback.deviceId,
      deviceName: String(raw.deviceName || fallback.deviceName).trim() || fallback.deviceName,
      password: Buffer.byteLength(password, "utf8") >= 16 ? password : fallback.password,
      listenHost: String(raw.listenHost || fallback.listenHost).trim() || fallback.listenHost,
      port: validPort(raw.port, fallback.port),
      discoveryPortStart: validPort(raw.discoveryPortStart, fallback.discoveryPortStart),
      discoveryPortEnd: validPort(raw.discoveryPortEnd, fallback.discoveryPortEnd),
      profile: normalizeProfile(raw.profile)
    };
    if (config.discoveryPortEnd < config.discoveryPortStart) {
      config.discoveryPortEnd = config.discoveryPortStart;
    }
    if (!fs.existsSync(this.configPath)) this.write(config);
    return config;
  }

  updateProfile(value: unknown): RemoteAgentHostConfig {
    return this.write({ ...this.read(), profile: normalizeProfile(value) });
  }

  patchSettings(patch: RemoteAgentHostSettingsPatch): RemoteAgentHostConfig {
    const current = this.read();
    const password = patch.regeneratePassword
      ? generatedPassword()
      : patch.password === undefined
        ? current.password
        : String(patch.password);
    if (Buffer.byteLength(password, "utf8") < 16) {
      throw new Error("设备密码至少需要 16 个 UTF-8 字节。");
    }
    const next = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      deviceName: patch.deviceName === undefined
        ? current.deviceName
        : String(patch.deviceName).trim() || os.hostname(),
      password,
      listenHost: patch.listenHost === undefined
        ? current.listenHost
        : String(patch.listenHost).trim() || "0.0.0.0",
      port: patch.port === undefined ? current.port : validPort(patch.port, Number.NaN),
      discoveryPortStart: patch.discoveryPortStart === undefined
        ? current.discoveryPortStart
        : validPort(patch.discoveryPortStart, Number.NaN),
      discoveryPortEnd: patch.discoveryPortEnd === undefined
        ? current.discoveryPortEnd
        : validPort(patch.discoveryPortEnd, Number.NaN)
    };
    if (![next.port, next.discoveryPortStart, next.discoveryPortEnd].every(Number.isInteger)) {
      throw new Error("端口必须是 1-65535 的整数。");
    }
    if (next.discoveryPortEnd < next.discoveryPortStart) {
      throw new Error("发现端口结束值不能小于起始值。");
    }
    return this.write(next);
  }

  private write(config: RemoteAgentHostConfig): RemoteAgentHostConfig {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, this.configPath);
    try { fs.chmodSync(this.configPath, 0o600); } catch { /* Windows ACLs apply. */ }
    return config;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const CONFIG_SCHEMA_VERSION = 1;

export function defaultConfigPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA?.trim();
  const base = localAppData || path.join(os.homedir(), ".rabiroute");
  return path.join(base, "RabiRoute", "RemoteAgent", "config.json");
}

export function createDefaultConfig({ defaultCwd, deviceName = os.hostname() }) {
  const canonicalCwd = resolveWorkspace(defaultCwd);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceName: String(deviceName || os.hostname()).trim() || os.hostname(),
    defaultCwd: canonicalCwd,
    allowedCwds: [canonicalCwd],
    defaultThreadName: "Remote Agent",
    password: randomBytes(24).toString("base64url"),
    allowNetwork: false
  };
}

export function resolveWorkspace(value) {
  const candidate = path.resolve(String(value || "").trim());
  if (!value || !fs.existsSync(candidate)) {
    throw new Error(`项目目录不存在：${candidate}`);
  }
  const stat = fs.statSync(candidate);
  if (!stat.isDirectory()) {
    throw new Error(`项目路径不是目录：${candidate}`);
  }
  return fs.realpathSync.native(candidate);
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("远端 Agent 配置必须是 JSON 对象。");
  }
  if (Number(value.schemaVersion) !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`不支持的配置版本：${String(value.schemaVersion)}`);
  }
  const defaultCwd = resolveWorkspace(value.defaultCwd);
  const allowedInput = Array.isArray(value.allowedCwds) && value.allowedCwds.length
    ? value.allowedCwds
    : [defaultCwd];
  const allowedCwds = [...new Set(allowedInput.map(resolveWorkspace))];
  if (!allowedCwds.some((root) => isWithin(defaultCwd, root))) {
    throw new Error("默认项目目录必须位于 allowedCwds 的某个根目录内。");
  }
  const password = String(value.password || "");
  if (Buffer.byteLength(password, "utf8") < 16) {
    throw new Error("设备密码至少需要 16 个 UTF-8 字节。");
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceName: String(value.deviceName || os.hostname()).trim() || os.hostname(),
    defaultCwd,
    allowedCwds,
    defaultThreadName: String(value.defaultThreadName || "Remote Agent").trim() || "Remote Agent",
    password,
    allowNetwork: value.allowNetwork === true
  };
}

export function readConfig(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return validateConfig(parsed);
}

export function writeConfig(configPath, config) {
  const normalized = validateConfig(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tempPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows ACLs remain owned by the current user profile. chmod is best-effort.
  }
  return normalized;
}

export function bridgeEnvironment(config, env = process.env) {
  const normalized = validateConfig(config);
  return {
    ...env,
    REMOTE_AGENT_PASSWORD: env.REMOTE_AGENT_PASSWORD || normalized.password,
    REMOTE_AGENT_DEVICE_NAME: env.REMOTE_AGENT_DEVICE_NAME || normalized.deviceName,
    REMOTE_AGENT_DEFAULT_CWD: env.REMOTE_AGENT_DEFAULT_CWD || normalized.defaultCwd,
    REMOTE_AGENT_ALLOWED_CWDS: env.REMOTE_AGENT_ALLOWED_CWDS || JSON.stringify(normalized.allowedCwds),
    REMOTE_AGENT_DEFAULT_THREAD: env.REMOTE_AGENT_DEFAULT_THREAD || normalized.defaultThreadName,
    REMOTE_AGENT_ALLOW_NETWORK: env.REMOTE_AGENT_ALLOW_NETWORK || (normalized.allowNetwork ? "1" : "0")
  };
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

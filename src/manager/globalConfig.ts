import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RabiGlobalConfig = {
  rabiGuid: string;
  rabiName: string;
  rabiLinkRelay: RabiLinkRelayGlobalConfig;
  createdAt: string;
  updatedAt: string;
};

export type RabiLinkRelayGlobalConfig = {
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  claimWaitMs: number;
  replyIdleTimeoutMs: number;
};

export class RabiGlobalConfigStore {
  readonly rootDir: string;
  readonly configPath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.configPath = path.join(rootDir, "data", "Config.json");
  }

  read(): RabiGlobalConfig {
    const current = this.readExisting();
    if (current) return current;

    const now = new Date().toISOString();
    const created: RabiGlobalConfig = {
      rabiGuid: randomUUID(),
      rabiName: os.hostname() || "RabiRoute",
      rabiLinkRelay: defaultRabiLinkRelayConfig(),
      createdAt: now,
      updatedAt: now
    };
    this.write(created);
    return created;
  }

  patch(patch: Partial<Pick<RabiGlobalConfig, "rabiName">> & { rabiLinkRelay?: Partial<RabiLinkRelayGlobalConfig> }): RabiGlobalConfig {
    const current = this.read();
    const next: RabiGlobalConfig = {
      ...current,
      rabiName: typeof patch.rabiName === "string" && patch.rabiName.trim()
        ? patch.rabiName.trim()
        : current.rabiName,
      rabiLinkRelay: patch.rabiLinkRelay
        ? normalizeRabiLinkRelayConfig({ ...current.rabiLinkRelay, ...patch.rabiLinkRelay })
        : current.rabiLinkRelay,
      updatedAt: new Date().toISOString()
    };
    this.write(next);
    return next;
  }

  private readExisting(): RabiGlobalConfig | null {
    if (!fs.existsSync(this.configPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<RabiGlobalConfig>;
      const now = new Date().toISOString();
      const normalized: RabiGlobalConfig = {
        rabiGuid: typeof parsed.rabiGuid === "string" && parsed.rabiGuid.trim() ? parsed.rabiGuid.trim() : randomUUID(),
        rabiName: typeof parsed.rabiName === "string" && parsed.rabiName.trim() ? parsed.rabiName.trim() : os.hostname() || "RabiRoute",
        rabiLinkRelay: normalizeRabiLinkRelayConfig(parsed.rabiLinkRelay),
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.trim() ? parsed.createdAt.trim() : now,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : now
      };
      if (
        normalized.rabiGuid !== parsed.rabiGuid
        || normalized.rabiName !== parsed.rabiName
        || JSON.stringify(normalized.rabiLinkRelay) !== JSON.stringify(parsed.rabiLinkRelay)
        || normalized.createdAt !== parsed.createdAt
        || normalized.updatedAt !== parsed.updatedAt
      ) {
        this.write(normalized);
      }
      return normalized;
    } catch {
      return null;
    }
  }

  private write(config: RabiGlobalConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function defaultRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig {
  return {
    enabled: false,
    url: "",
    token: "",
    deviceId: os.hostname() || "rabilink-pc",
    claimWaitMs: 60000,
    replyIdleTimeoutMs: 60000
  };
}

function normalizeRabiLinkRelayConfig(raw: unknown): RabiLinkRelayGlobalConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<RabiLinkRelayGlobalConfig>
    : {};
  const defaults = defaultRabiLinkRelayConfig();
  const url = typeof source.url === "string" ? source.url.trim() : "";
  const token = typeof source.token === "string" ? source.token.trim() : "";
  return {
    enabled: Boolean(url && token),
    url,
    token,
    deviceId: typeof source.deviceId === "string" && source.deviceId.trim() ? source.deviceId.trim() : defaults.deviceId,
    claimWaitMs: normalizeNumber(source.claimWaitMs, defaults.claimWaitMs, 0, 60000),
    replyIdleTimeoutMs: normalizeNumber(source.replyIdleTimeoutMs, defaults.replyIdleTimeoutMs, 1000, 120000)
  };
}

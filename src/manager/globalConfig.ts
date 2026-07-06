import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RabiGlobalConfig = {
  rabiGuid: string;
  rabiName: string;
  createdAt: string;
  updatedAt: string;
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
      createdAt: now,
      updatedAt: now
    };
    this.write(created);
    return created;
  }

  patch(patch: Partial<Pick<RabiGlobalConfig, "rabiName">>): RabiGlobalConfig {
    const current = this.read();
    const next: RabiGlobalConfig = {
      ...current,
      rabiName: typeof patch.rabiName === "string" && patch.rabiName.trim()
        ? patch.rabiName.trim()
        : current.rabiName,
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
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.trim() ? parsed.createdAt.trim() : now,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : now
      };
      if (
        normalized.rabiGuid !== parsed.rabiGuid
        || normalized.rabiName !== parsed.rabiName
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

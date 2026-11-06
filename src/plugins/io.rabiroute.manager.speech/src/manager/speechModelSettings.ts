import { validateLocalModelDirectory } from "@rabiroute/host-api/shared/localModelDirectory";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { SpeechModelSettingsError } from "@rabiroute/host-api/shared/speechErrors";
export { SpeechModelSettingsError } from "@rabiroute/host-api/shared/speechErrors";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteFileSync, withFileLockSync } from "@rabiroute/host-api/shared/filePersistence";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import type { SpeechModelDirectorySettings } from "@rabiroute/host-api/shared/speechModelManagement";

export function validateModelRoot(value: unknown, protectedRoots: string[], fixedDrive?: (drive: string) => boolean): string | null {
  return validateLocalModelDirectory(value, protectedRoots, fixedDrive, message => new SpeechModelSettingsError(message));
}


export class SpeechModelSettingsStore {
  private readonly filePath: string;
  constructor(private readonly rootDir: string, private readonly protectedRoots: string[], private readonly validate = validateModelRoot) {
    this.filePath = path.join(rootDir, "data", "speech", "model-directory-settings.json");
  }
  private readRecord(): { revision: number; modelRoot: string | null } {
    if (!fs.existsSync(this.filePath)) return { revision: 0, modelRoot: null };
    try {
      if (fs.statSync(this.filePath).size > 8192) throw new Error("oversize");
      const row = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Number.isSafeInteger(row.revision) || row.revision < 0 || (row.modelRoot !== null && typeof row.modelRoot !== "string")) throw new Error("invalid");
      return row;
    } catch { throw new SpeechModelSettingsError("模型目录设置无法读取，请恢复本机设置文件。", 500); }
  }
  read(defaultRoot: string, environmentRoot?: string): SpeechModelDirectorySettings {
    const row = this.readRecord();
    return { revision: row.revision, configuredModelRoot: row.modelRoot, effectiveModelRoot: row.modelRoot || environmentRoot || defaultRoot, defaultModelRoot: environmentRoot || defaultRoot, source: row.modelRoot ? "configured" : environmentRoot ? "environment" : "default" };
  }
  assertConfiguredRootSafe(): void {
    const row = this.readRecord();
    if (row.modelRoot) this.validate(row.modelRoot, this.protectedRoots);
  }
  write(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechModelSettingsError("模型目录设置格式无效。");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== "modelRoot" && key !== "expectedRevision") || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !("modelRoot" in body)) throw new SpeechModelSettingsError("需要模型目录和当前设置版本。");
    const modelRoot = this.validate(body.modelRoot, this.protectedRoots);
    withFileLockSync(`${this.filePath}.lock`, () => {
      const previous = this.readRecord();
      if (previous.revision !== body.expectedRevision) throw new SpeechModelSettingsError("模型目录设置已改变，请刷新后重试。", 409);
      if (previous.modelRoot === modelRoot) return;
      atomicWriteFileSync(this.filePath, `${JSON.stringify({ revision: previous.revision + 1, modelRoot }, null, 2)}\n`);
      recordDataMutationAudit({ group: "config.speech", event: "speech_model_directory_updated", owner: "SpeechModelSettingsStore", action: "write", target: { type: "speech_model_settings", id: "model-directory" }, dataSource: { kind: "file", id: "data/speech/model-directory-settings.json" }, outcome: "committed", changes: [{ field: "modelRoot" }] });
    });
  }
}

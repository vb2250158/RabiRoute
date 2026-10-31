import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { cameraClipPath, type CameraEvent } from "./cameraEvents.js";

export type XiaomiHomeArtifactInput = {
  sourceEventId: string;
  ownerRoleId?: string;
  resourceId: string;
  eventKind: string;
  occurredAt: string;
  mediaKind: "video/mp4" | "image/jpeg";
  localPath: string;
  sha256: string;
  byteLength: number;
  durationMs?: number;
};

export type XiaomiHomeArtifactRecord = XiaomiHomeArtifactInput & {
  artifactId: string;
  ingestedAt: string;
  contentAvailable: true;
};

export type XiaomiHomeArtifactPublicRecord = Omit<XiaomiHomeArtifactRecord, "localPath">;

export type XiaomiHomeArtifactAccessRecord = {
  accessId: string;
  artifactId: string;
  accessedAt: string;
  actor: string;
  reason: string;
  byteRange?: string;
};

type ArtifactIndex = {
  schemaVersion: 1;
  byArtifactId: Record<string, XiaomiHomeArtifactRecord>;
  bySourceEventId: Record<string, string>;
  blockedArtifacts: Record<string, true>;
  blockedSources: Record<string, true>;
  coverage: {
    state: "complete" | "partial";
    invalidRecords: number;
    identityComplete: boolean;
    sourceIdentityComplete: boolean;
    artifactIdentityComplete: boolean;
    samples: Array<{ shard: string; line: number; reason: string }>;
  };
};

export class XiaomiHomeArtifactEvidenceError extends Error {
  readonly status = 409;
  readonly code = "xiaomi_home_artifact_evidence_unavailable";
  constructor() { super("Original artifact evidence is incomplete or conflicting. Inspect artifacts/lifecycle and repair the original ledger before registering or treating this identity as absent."); }
}

const stableIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;

function defaultRuntimeDir(): string {
  const local = String(process.env.LOCALAPPDATA || "").trim();
  return path.join(local || os.tmpdir(), "RabiRoute", "XiaomiHome");
}

function localAbsolutePath(input: string, field: string): string {
  const resolved = path.resolve(input);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return resolved;
}

function atomicWrite(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, filePath);
}

function publicRecord(record: XiaomiHomeArtifactRecord): XiaomiHomeArtifactPublicRecord {
  const { localPath: _localPath, ...safe } = record;
  return safe;
}

function artifactSourceKey(sourceEventId: string, ownerRoleId?: string): string {
  return JSON.stringify([ownerRoleId ?? null, sourceEventId]);
}

export class XiaomiHomeArtifactStore {
  readonly runtimeDir: string;
  private readonly ledgerDir: string;
  private readonly mediaDir: string;
  private readonly accessDir: string;
  private readonly indexPath: string;
  private index: ArtifactIndex;
  private readonly cameraAllocations = new Set<string>();

  constructor(runtimeDir = defaultRuntimeDir(), customMediaDir?: string) {
    this.runtimeDir = localAbsolutePath(runtimeDir, "runtimeDir");
    this.ledgerDir = path.join(this.runtimeDir, "artifacts", "ledger");
    this.mediaDir = customMediaDir
      ? localAbsolutePath(customMediaDir, "mediaDir")
      : path.join(this.runtimeDir, "artifacts", "media");
    this.accessDir = path.join(this.runtimeDir, "artifacts", "access");
    this.indexPath = path.join(this.runtimeDir, "artifacts", "index.json");
    this.index = this.readLedgerIndex();
  }

  /** Explicit native activation: run only after publication and predecessor retirement. */
  activate(): void {
    // The predecessor may have appended after this candidate's read-only preparation.
    const index = this.readLedgerIndex();
    fs.mkdirSync(this.ledgerDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(this.accessDir, { recursive: true });
    atomicWrite(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
    this.index = index;
  }

  getMediaDir(): string {
    return this.mediaDir;
  }

  allocateCameraPath(roleDirectory: string, event: CameraEvent): string {
    const target = cameraClipPath(roleDirectory, event);
    this.cameraAllocations.add(target);
    return target;
  }

  releaseCameraPath(target: string): void {
    this.cameraAllocations.delete(target);
  }

  allocateMediaPath(sourceEventId: string, occurredAt: string, extension: ".mp4" | ".jpg"): string {
    const timestamp = new Date(occurredAt);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("occurredAt is invalid.");
    const stableName = createHash("sha256").update(String(sourceEventId || "")).digest("hex").slice(0, 32);
    const date = timestamp.toISOString().slice(0, 10).split("-");
    const targetDir = path.join(this.mediaDir, ...date);
    fs.mkdirSync(targetDir, { recursive: true });
    return path.join(targetDir, `${stableName}${extension}`);
  }

  private ledgerPath(occurredAt: string): string {
    const timestamp = new Date(occurredAt);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("occurredAt is invalid.");
    return path.join(this.ledgerDir, `${timestamp.toISOString().slice(0, 10)}.jsonl`);
  }

  private readLedgerIndex(): ArtifactIndex {
    const index: ArtifactIndex = { schemaVersion: 1, byArtifactId: Object.create(null), bySourceEventId: Object.create(null),
      blockedArtifacts: Object.create(null), blockedSources: Object.create(null),
      coverage: { state: "complete", invalidRecords: 0, identityComplete: true, sourceIdentityComplete: true, artifactIdentityComplete: true, samples: [] } };
    const block = (artifactId?: string, sourceEventId?: string) => {
      const prior = artifactId ? index.byArtifactId[artifactId] : undefined;
      if (artifactId) { index.blockedArtifacts[artifactId] = true; delete index.byArtifactId[artifactId]; }
      if (prior) { const priorKey = artifactSourceKey(prior.sourceEventId, prior.ownerRoleId); index.blockedSources[priorKey] = true; delete index.bySourceEventId[priorKey]; }
      if (sourceEventId) {
        const previousId = index.bySourceEventId[sourceEventId];
        index.blockedSources[sourceEventId] = true; delete index.bySourceEventId[sourceEventId];
        if (previousId) { index.blockedArtifacts[previousId] = true; delete index.byArtifactId[previousId]; }
      }
    };
    const invalid = (shard: string, line: number, reason: string, artifactId?: string, sourceEventId?: string) => {
      index.coverage.state = "partial"; index.coverage.invalidRecords++;
      if (!sourceEventId) index.coverage.sourceIdentityComplete = false;
      if (!artifactId) index.coverage.artifactIdentityComplete = false;
      index.coverage.identityComplete = index.coverage.sourceIdentityComplete && index.coverage.artifactIdentityComplete;
      if (index.coverage.samples.length < 8) index.coverage.samples.push({ shard, line, reason });
      block(artifactId, sourceEventId);
    };
    let names: string[];
    try { names = fs.readdirSync(this.ledgerDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    const files = names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of files) {
      const rows = fs.readFileSync(path.join(this.ledgerDir, name), "utf8").split(/\r?\n/);
      for (const [offset, row] of rows.entries()) {
        if (!row.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(row); }
        catch { invalid(name, offset + 1, "invalid_json"); continue; }
        const record = value && typeof value === "object" && !Array.isArray(value) ? value as XiaomiHomeArtifactRecord : undefined;
        const artifactId = stableIdentity(record?.artifactId) ? record.artifactId : undefined;
        const sourceEventId = stableIdentity(record?.sourceEventId) && (record?.ownerRoleId === undefined || stableIdentity(record.ownerRoleId))
          ? artifactSourceKey(record.sourceEventId, record.ownerRoleId) : undefined;
        if (!record || !artifactId || !sourceEventId || typeof record.resourceId !== "string" || !record.resourceId || typeof record.eventKind !== "string" || !record.eventKind
          || !["video/mp4", "image/jpeg"].includes(record.mediaKind) || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0
          || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.sha256)
          || typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt))
          || typeof record.ingestedAt !== "string" || !Number.isFinite(Date.parse(record.ingestedAt)) || record.contentAvailable !== true
          || typeof record.localPath !== "string" || !path.isAbsolute(record.localPath)) {
          invalid(name, offset + 1, "invalid_record", artifactId, sourceEventId); continue;
        }
        const previous = index.byArtifactId[artifactId];
        const previousSource = index.bySourceEventId[sourceEventId];
        if (index.blockedArtifacts[artifactId] || index.blockedSources[sourceEventId]
          || previous && !isDeepStrictEqual(previous, record) || previousSource && previousSource !== artifactId) {
          invalid(name, offset + 1, "identity_conflict", artifactId, sourceEventId); continue;
        }
        index.byArtifactId[record.artifactId] = record;
        index.bySourceEventId[artifactSourceKey(record.sourceEventId, record.ownerRoleId)] = record.artifactId;
      }
    }
    return index;
  }

  coverage() { return { ...structuredClone(this.index.coverage), availableRecords: Object.keys(this.index.byArtifactId).length,
    blockedArtifactIds: Object.keys(this.index.blockedArtifacts).length, blockedSourceEventIds: Object.keys(this.index.blockedSources).length }; }

  private checkedRecord(artifactId: string): XiaomiHomeArtifactRecord | undefined {
    if (this.index.blockedArtifacts[artifactId]) throw new XiaomiHomeArtifactEvidenceError();
    const record = this.index.byArtifactId[artifactId];
    if (!record && !this.index.coverage.artifactIdentityComplete) throw new XiaomiHomeArtifactEvidenceError();
    return record;
  }

  register(input: XiaomiHomeArtifactInput): XiaomiHomeArtifactPublicRecord {
    const sourceEventId = String(input.sourceEventId || "").trim();
    if (!sourceEventId) throw new Error("sourceEventId is required.");
    if (input.ownerRoleId !== undefined && !stableIdentity(input.ownerRoleId)) throw new Error("ownerRoleId must be a stable nonempty identity.");
    const sourceKey = artifactSourceKey(sourceEventId, input.ownerRoleId);
    if (this.index.blockedSources[sourceKey]) throw new XiaomiHomeArtifactEvidenceError();
    const existingId = this.index.bySourceEventId[sourceKey];
    if (existingId) {
      const existing = this.index.byArtifactId[existingId];
      if (existing.sha256 !== input.sha256 || existing.resourceId !== input.resourceId) {
        throw new Error("sourceEventId already belongs to another artifact payload.");
      }
      recordDataMutationAudit({
        group: "xiaomi-home",
        event: "xiaomi_home_artifact_replayed",
        owner: "xiaomi-home-artifacts",
        action: "register-artifact",
        target: { type: "artifact", id: existing.artifactId },
        dataSource: { kind: "ledger", id: "xiaomi-home/artifacts" },
        outcome: "replayed",
        after: { digest: existing.sha256 }
      });
      return publicRecord(existing);
    }
    if (!this.index.coverage.sourceIdentityComplete) throw new XiaomiHomeArtifactEvidenceError();
    const mediaPath = localAbsolutePath(input.localPath, "localPath");
    const relative = path.relative(this.mediaDir, mediaPath);
    if ((!relative || relative.startsWith("..") || path.isAbsolute(relative)) && !this.cameraAllocations.has(mediaPath)) {
      throw new Error("localPath must stay inside the Xiaomi Home artifact media directory.");
    }
    if (!fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isFile()) throw new Error("Artifact media file does not exist.");
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("sha256 is invalid.");
    const actualBytes = fs.statSync(mediaPath).size;
    if (actualBytes !== input.byteLength) throw new Error("Artifact byteLength does not match the media file.");
    const record: XiaomiHomeArtifactRecord = {
      ...input,
      sourceEventId,
      localPath: mediaPath,
      artifactId: `xiaomi-artifact-${randomUUID()}`,
      ingestedAt: new Date().toISOString(),
      contentAvailable: true
    };
    const ledgerPath = this.ledgerPath(record.occurredAt);
    const current = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
    atomicWrite(ledgerPath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${JSON.stringify(record)}\n`);
    this.index.byArtifactId[record.artifactId] = record;
    this.index.bySourceEventId[sourceKey] = record.artifactId;
    atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
    recordDataMutationAudit({
      group: "xiaomi-home",
      event: "xiaomi_home_artifact_registered",
      owner: "xiaomi-home-artifacts",
      action: "register-artifact",
      target: { type: "artifact", id: record.artifactId },
      dataSource: { kind: "ledger", id: `xiaomi-home/artifacts/${record.occurredAt.slice(0, 10)}.jsonl` },
      outcome: "committed",
      after: { revision: record.ingestedAt, digest: record.sha256 },
      changes: [{ field: "byteLength", to: record.byteLength }]
    });
    return publicRecord(record);
  }

  get(artifactId: string): XiaomiHomeArtifactPublicRecord | undefined {
    const record = this.checkedRecord(artifactId);
    return record ? publicRecord(record) : undefined;
  }

  getBySourceEventId(sourceEventId: string, ownerRoleId?: string): XiaomiHomeArtifactPublicRecord | undefined {
    if (ownerRoleId !== undefined && !stableIdentity(ownerRoleId)) throw new Error("ownerRoleId must be a stable nonempty identity.");
    const key = artifactSourceKey(String(sourceEventId || "").trim(), ownerRoleId);
    if (this.index.blockedSources[key]) throw new XiaomiHomeArtifactEvidenceError();
    const artifactId = this.index.bySourceEventId[key];
    if (!artifactId && !this.index.coverage.sourceIdentityComplete) throw new XiaomiHomeArtifactEvidenceError();
    return artifactId ? this.get(artifactId) : undefined;
  }

  contentDescriptor(artifactId: string): { record: XiaomiHomeArtifactPublicRecord; localPath: string } | undefined {
    const record = this.checkedRecord(String(artifactId || "").trim());
    if (!record || !fs.existsSync(record.localPath) || !fs.statSync(record.localPath).isFile()) return undefined;
    return { record: publicRecord(record), localPath: record.localPath };
  }

  recordAccess(input: Omit<XiaomiHomeArtifactAccessRecord, "accessId" | "accessedAt">): XiaomiHomeArtifactAccessRecord {
    if (!this.checkedRecord(input.artifactId)) throw new Error("Artifact was not found.");
    const record: XiaomiHomeArtifactAccessRecord = {
      ...input,
      accessId: `xiaomi-access-${randomUUID()}`,
      accessedAt: new Date().toISOString()
    };
    const ledgerPath = path.join(this.accessDir, `${record.accessedAt.slice(0, 10)}.jsonl`);
    const current = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
    atomicWrite(ledgerPath, `${current}${JSON.stringify(record)}\n`);
    recordDataMutationAudit({
      group: "xiaomi-home",
      event: "xiaomi_home_artifact_access_recorded",
      owner: "xiaomi-home-artifacts",
      action: "record-access",
      target: { type: "artifact", id: record.artifactId },
      dataSource: { kind: "ledger", id: `xiaomi-home/access/${record.accessedAt.slice(0, 10)}.jsonl` },
      outcome: "committed",
      after: { revision: record.accessId }
    });
    return record;
  }

  list(filter: { resourceId?: string; eventKind?: string } = {}): XiaomiHomeArtifactPublicRecord[] {
    return Object.values(this.index.byArtifactId)
      .filter(record => !filter.resourceId || record.resourceId === filter.resourceId)
      .filter(record => !filter.eventKind || record.eventKind === filter.eventKind)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map(publicRecord);
  }

  lifecycleContract(): Record<string, unknown> {
    return {
      recordClass: "ledger",
      sourceOfTruth: this.ledgerDir,
      stableId: "artifactId",
      idempotencyKey: "sourceEventId",
      orderBy: "ingestedAt",
      activityAt: "occurredAt",
      action: "daily physical sharding; no archive or deletion implemented",
      index: this.indexPath,
      sourceRetention: "retained",
      coverage: this.coverage(),
      recovery: "rebuild index from all complete JSONL shard records on startup",
      accessAudit: `${this.accessDir} uses daily physical shards; records are retained and contain no credentials`
    };
  }
}

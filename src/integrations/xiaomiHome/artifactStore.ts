import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";

export type XiaomiHomeArtifactInput = {
  sourceEventId: string;
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
};

function defaultRuntimeDir(): string {
  const local = String(process.env.LOCALAPPDATA || "").trim();
  return path.join(local || os.tmpdir(), "RabiRoute", "XiaomiHome");
}

function localAbsolutePath(input: string, field: string): string {
  const resolved = path.resolve(input);
  if (!path.isAbsolute(resolved) || resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    throw new Error(`${field} must be an absolute local path.`);
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

export class XiaomiHomeArtifactStore {
  readonly runtimeDir: string;
  private readonly ledgerDir: string;
  private readonly mediaDir: string;
  private readonly accessDir: string;
  private readonly indexPath: string;
  private index: ArtifactIndex;

  constructor(runtimeDir = defaultRuntimeDir()) {
    this.runtimeDir = localAbsolutePath(runtimeDir, "runtimeDir");
    this.ledgerDir = path.join(this.runtimeDir, "artifacts", "ledger");
    this.mediaDir = path.join(this.runtimeDir, "artifacts", "media");
    this.accessDir = path.join(this.runtimeDir, "artifacts", "access");
    this.indexPath = path.join(this.runtimeDir, "artifacts", "index.json");
    fs.mkdirSync(this.ledgerDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(this.accessDir, { recursive: true });
    this.index = this.rebuildIndex();
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

  private rebuildIndex(): ArtifactIndex {
    const index: ArtifactIndex = { schemaVersion: 1, byArtifactId: {}, bySourceEventId: {} };
    const files = fs.readdirSync(this.ledgerDir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of files) {
      const rows = fs.readFileSync(path.join(this.ledgerDir, name), "utf8").split(/\r?\n/).filter(Boolean);
      for (const row of rows) {
        const record = JSON.parse(row) as XiaomiHomeArtifactRecord;
        if (!record.artifactId || !record.sourceEventId) continue;
        index.byArtifactId[record.artifactId] = record;
        index.bySourceEventId[record.sourceEventId] = record.artifactId;
      }
    }
    atomicWrite(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
    return index;
  }

  register(input: XiaomiHomeArtifactInput): XiaomiHomeArtifactPublicRecord {
    const sourceEventId = String(input.sourceEventId || "").trim();
    if (!sourceEventId) throw new Error("sourceEventId is required.");
    const existingId = this.index.bySourceEventId[sourceEventId];
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
    const mediaPath = localAbsolutePath(input.localPath, "localPath");
    const relative = path.relative(this.mediaDir, mediaPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
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
    atomicWrite(ledgerPath, `${current}${JSON.stringify(record)}\n`);
    this.index.byArtifactId[record.artifactId] = record;
    this.index.bySourceEventId[record.sourceEventId] = record.artifactId;
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
    const record = this.index.byArtifactId[artifactId];
    return record ? publicRecord(record) : undefined;
  }

  getBySourceEventId(sourceEventId: string): XiaomiHomeArtifactPublicRecord | undefined {
    const artifactId = this.index.bySourceEventId[String(sourceEventId || "").trim()];
    return artifactId ? this.get(artifactId) : undefined;
  }

  contentDescriptor(artifactId: string): { record: XiaomiHomeArtifactPublicRecord; localPath: string } | undefined {
    const record = this.index.byArtifactId[String(artifactId || "").trim()];
    if (!record || !fs.existsSync(record.localPath) || !fs.statSync(record.localPath).isFile()) return undefined;
    return { record: publicRecord(record), localPath: record.localPath };
  }

  recordAccess(input: Omit<XiaomiHomeArtifactAccessRecord, "accessId" | "accessedAt">): XiaomiHomeArtifactAccessRecord {
    if (!this.index.byArtifactId[input.artifactId]) throw new Error("Artifact was not found.");
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
      recovery: "rebuild index from all complete JSONL shard records on startup",
      accessAudit: `${this.accessDir} uses daily physical shards; records are retained and contain no credentials`
    };
  }
}

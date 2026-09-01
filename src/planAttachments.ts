import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PLAN_ATTACHMENT_MAX_BYTES,
  PLAN_ATTACHMENTS_MAX_BYTES,
  PLAN_MAX_ATTACHMENTS,
  type PlanAttachment,
  type PlanAttachmentInput
} from "./shared/planAttachmentContract.js";
import {
  planAttachmentDirectory as planStorageAttachmentDirectory,
  type PlanStorageBucket
} from "./planStorageLayout.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip"
};

function safeIdPart(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function safeFileName(value: unknown, fallback: string): string {
  const base = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_");
  return (base || fallback).slice(0, 180);
}

function normalizeMimeType(value: unknown): string | undefined {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mimeType ? mimeType.slice(0, 160) : undefined;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeBase64(value: unknown, name: string): Buffer {
  if (typeof value !== "string") throw new Error(`Plan attachment content is required: ${name}.`);
  const encoded = value.replace(/\s+/g, "");
  if (encoded && (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) {
    throw new Error(`Plan attachment is not valid base64: ${name}.`);
  }
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64").replace(/=+$/g, "") !== encoded.replace(/=+$/g, "")) {
    throw new Error(`Plan attachment is not valid base64: ${name}.`);
  }
  return content;
}

function hasExpectedImageSignature(mimeType: string, body: Buffer): boolean {
  if (mimeType === "image/png") return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (mimeType === "image/webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "image/gif") {
    const signature = body.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return false;
}

function hasExpectedVideoSignature(mimeType: string, body: Buffer): boolean {
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
    return body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (mimeType === "video/webm") {
    return body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === "video/ogg") return body.subarray(0, 4).toString("ascii") === "OggS";
  return false;
}

function inferredMimeType(name: string): string | undefined {
  return MIME_TYPES_BY_EXTENSION[path.extname(name).toLowerCase()];
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function planAttachmentDirectory(
  roleDir: string,
  planId: string,
  bucket: PlanStorageBucket = "active"
): string {
  return planStorageAttachmentDirectory(roleDir, planId, bucket);
}

export function normalizeStoredPlanAttachments(value: unknown): PlanAttachment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Partial<PlanAttachment>;
    const id = safeIdPart(raw.id);
    const filePath = String(raw.path || "").trim();
    const digest = String(raw.sha256 || "").trim().toLowerCase();
    const size = Number(raw.size);
    if (!id || seen.has(id) || !filePath || !/^[a-f0-9]{64}$/.test(digest) || !Number.isFinite(size) || size < 0) return [];
    seen.add(id);
    const name = safeFileName(raw.name, "attachment");
    const mimeType = normalizeMimeType(raw.mimeType) || inferredMimeType(name);
    const kind = raw.kind === "image" || raw.kind === "video"
      ? raw.kind
      : mimeType && IMAGE_MIME_TYPES.has(mimeType)
        ? "image"
        : mimeType && VIDEO_MIME_TYPES.has(mimeType)
          ? "video"
          : "file";
    return [{
      id,
      kind,
      name,
      path: filePath,
      size,
      mimeType,
      sha256: digest
    }];
  });
}

export type PreparedPlanAttachment = {
  metadata: PlanAttachment;
  content?: Buffer;
};

/**
 * Validates attachment input and materializes immutable bytes in memory.
 * The caller must publish the returned files through the plan-storage Repository;
 * this function never creates or changes a managed plan directory.
 */
export function preparePlanAttachments(
  roleDir: string,
  planId: string,
  value: unknown,
  existingValue: unknown = [],
  bucket: PlanStorageBucket = "active"
): PreparedPlanAttachment[] {
  if (!Array.isArray(value)) throw new Error("Plan attachments must be an array.");
  if (value.length > PLAN_MAX_ATTACHMENTS) {
    throw new Error(`A plan supports at most ${PLAN_MAX_ATTACHMENTS} attachments.`);
  }

  const existing = normalizeStoredPlanAttachments(existingValue);
  const existingById = new Map(existing.map((attachment) => [attachment.id, attachment]));
  const attachmentDir = planAttachmentDirectory(roleDir, planId, bucket);
  const usedIds = new Set<string>();
  let total = 0;
  const prepared = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Plan attachment ${index + 1} is invalid.`);
    }
    const raw = item as PlanAttachmentInput;
    const requestedId = safeIdPart(raw.id);
    const prior = requestedId ? existingById.get(requestedId) : undefined;
    const sourcePath = typeof raw.path === "string" ? raw.path.trim() : "";
    const hasBase64 = Object.prototype.hasOwnProperty.call(raw, "contentBase64");
    if (prior && !hasBase64 && (!sourcePath || path.resolve(sourcePath) === path.resolve(prior.path))) {
      if (usedIds.has(prior.id)) throw new Error(`Plan attachment id is duplicated: ${prior.id}.`);
      usedIds.add(prior.id);
      total += prior.size;
      if (total > PLAN_ATTACHMENTS_MAX_BYTES) {
        throw new Error(`Plan attachments exceed ${PLAN_ATTACHMENTS_MAX_BYTES} bytes in total.`);
      }
      return { metadata: prior };
    }
    if (hasBase64 === Boolean(sourcePath)) {
      throw new Error(`Plan attachment ${index + 1} must provide exactly one of path or contentBase64.`);
    }

    const fallbackName = sourcePath ? path.basename(sourcePath) : `attachment-${index + 1}`;
    const name = safeFileName(raw.name, fallbackName);
    let content: Buffer;
    if (sourcePath) {
      const resolvedSource = path.resolve(sourcePath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolvedSource);
      } catch {
        throw new Error(`Plan attachment path does not exist: ${sourcePath}.`);
      }
      if (!stat.isFile()) throw new Error(`Plan attachment path is not a file: ${sourcePath}.`);
      if (stat.size > PLAN_ATTACHMENT_MAX_BYTES) {
        throw new Error(`Plan attachment exceeds ${PLAN_ATTACHMENT_MAX_BYTES} bytes: ${name}.`);
      }
      content = fs.readFileSync(resolvedSource);
    } else {
      content = decodeBase64(raw.contentBase64, name);
    }
    if (content.byteLength > PLAN_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Plan attachment exceeds ${PLAN_ATTACHMENT_MAX_BYTES} bytes: ${name}.`);
    }
    total += content.byteLength;
    if (total > PLAN_ATTACHMENTS_MAX_BYTES) {
      throw new Error(`Plan attachments exceed ${PLAN_ATTACHMENTS_MAX_BYTES} bytes in total.`);
    }

    const mimeType = normalizeMimeType(raw.mimeType) || inferredMimeType(name);
    if (mimeType && IMAGE_MIME_TYPES.has(mimeType) && !hasExpectedImageSignature(mimeType, content)) {
      throw new Error(`Plan attachment content does not match its image type: ${name}.`);
    }
    if (mimeType && VIDEO_MIME_TYPES.has(mimeType) && !hasExpectedVideoSignature(mimeType, content)) {
      throw new Error(`Plan attachment content does not match its video type: ${name}.`);
    }
    const id = requestedId || `attachment-${randomUUID()}`;
    if (usedIds.has(id) || (requestedId && existingById.has(requestedId))) {
      throw new Error(`Plan attachment id is duplicated: ${id}.`);
    }
    usedIds.add(id);
    const target = path.join(attachmentDir, `${safeIdPart(id)}-${name}`);
    return {
      content,
      metadata: {
        id,
        kind: mimeType && IMAGE_MIME_TYPES.has(mimeType)
          ? "image" as const
          : mimeType && VIDEO_MIME_TYPES.has(mimeType)
            ? "video" as const
            : "file" as const,
        name,
        path: target,
        size: content.byteLength,
        mimeType,
        sha256: sha256(content)
      }
    };
  });

  for (const item of prepared) {
    if (!item.content) continue;
    if (fs.existsSync(item.metadata.path)) {
      if (sha256(fs.readFileSync(item.metadata.path)) !== item.metadata.sha256) {
        throw new Error(`Plan attachment path already contains different content: ${item.metadata.name}.`);
      }
    }
  }
  return prepared;
}

export function resolvePlanAttachmentFile(roleDir: string, planId: string, attachment: PlanAttachment): string {
  const candidate = path.resolve(attachment.path);
  const managedRoots = [
    planAttachmentDirectory(roleDir, planId, "active"),
    planAttachmentDirectory(roleDir, planId, "archive")
  ].map((directory) => path.resolve(directory));
  const attachmentDir = managedRoots.find((directory) => pathWithin(directory, candidate));
  if (!attachmentDir) throw new Error("Plan attachment path is outside its managed directory.");
  const realRoot = fs.realpathSync(attachmentDir);
  const realCandidate = fs.realpathSync(candidate);
  if (!pathWithin(realRoot, realCandidate)) throw new Error("Plan attachment path leaves its managed directory.");
  if (!fs.statSync(realCandidate).isFile()) throw new Error("Plan attachment is not a file.");
  return realCandidate;
}

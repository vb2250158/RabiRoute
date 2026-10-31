import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolvePlanAttachmentFile } from "../planAttachments.js";
import { getPlan } from "../roleKnowledge.js";
import type { PlanAttachment } from "../shared/planAttachmentContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";

function contentDisposition(attachment: PlanAttachment): string {
  const mode = attachment.kind === "image" || attachment.kind === "video" ? "inline" : "attachment";
  const asciiName = path.basename(attachment.name)
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_") || "attachment";
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(path.basename(attachment.name))}`;
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error("Invalid byte range.");
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error("Invalid byte range.");
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    throw new Error("Invalid byte range.");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Resolve metadata and bytes through the native managed attachment owner. */
export function createPlanAttachmentOwner(options: { roleDir(roleId: string): string; identity?(): PersonaResourceIdentity }) {
  return {
    prepare(request: http.IncomingMessage, rawRoleId: string, planId: string, attachmentId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, options.identity);
      const roleId = sanitizeRoleId(rawRoleId);
      if (!roleId || !planId || !attachmentId) throw Object.assign(new Error("Invalid plan attachment path."), { statusCode: 400 });
      const roleDir = options.roleDir(roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(options.roleDir(roleId)) !== path.resolve(roleDir)) throw Object.assign(new Error("Persona directory changed while using the original plan owner."), { statusCode: 409 });
      };
      return {
        read(rangeHeader?: string) {
          assertCurrent();
          const plan = getPlan(roleDir, planId);
          const attachment = plan?.attachments.find(item => item.id === attachmentId);
          if (!plan || !attachment) throw Object.assign(new Error("Plan attachment not found."), { statusCode: 404 });
          const filePath = resolvePlanAttachmentFile(roleDir, plan.id, attachment);
          const body = fs.readFileSync(filePath);
          let range: { start: number; end: number } | undefined;
          try { range = parseByteRange(rangeHeader, body.byteLength); }
          catch { return { status: 416, headers: { "content-range": `bytes */${body.byteLength}`, "accept-ranges": "bytes", "x-content-type-options": "nosniff" } }; }
          const bytes = range ? body.subarray(range.start, range.end + 1) : body;
          assertCurrent();
          return { status: range ? 206 : 200, bytes, headers: {
            "content-type": attachment.mimeType || "application/octet-stream",
            "content-length": String(bytes.byteLength), "content-disposition": contentDisposition(attachment),
            "cache-control": "private, max-age=3600", "accept-ranges": "bytes",
            ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}` } : {}),
            "x-content-type-options": "nosniff"
          } };
        }
      };
    }
  };
}

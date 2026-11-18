import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MessageEndpointManagedAttachmentFile, MessageEndpointManagedAttachmentPort, MessageEndpointManagedAttachmentReference
} from "@rabiroute/plugin-sdk";
import { resolvePlanAttachmentFile } from "../planAttachments.js";
import { getPlan } from "../roleKnowledge.js";
import { PLAN_ATTACHMENT_MAX_BYTES } from "../shared/planAttachmentContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import type { AgentUploadStore } from "./agentUploadStore.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { getTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";

type PlanReference = { roleId?: string; planId: string; attachmentId: string };
type UploadReference = { fileId: string; fileSha256: string };
type AttachmentFile = MessageEndpointManagedAttachmentFile;
type Operation<T> = (file: AttachmentFile) => T | Promise<T>;

function hasExactFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

function validReference(value: unknown): value is MessageEndpointManagedAttachmentReference {
  if (hasExactFields(value, ["fileId", "fileSha256"])) {
    // The original upload store validates and resolves the ID.
    return typeof value.fileId === "string" && typeof value.fileSha256 === "string" && /^[a-f0-9]{64}$/.test(value.fileSha256);
  }
  return hasExactFields(value, ["planAttachment"])
    && hasExactFields(value.planAttachment, ["roleId", "planId", "attachmentId"])
    && Object.values(value.planAttachment).every(field => typeof field === "string" && Boolean(field.trim()));
}

async function useAttachment<T>(file: AttachmentFile, assertCurrent: () => void, operation: Operation<T>): Promise<T> {
  assertCurrent();
  const result = await operation(Object.freeze(file));
  assertCurrent();
  return result;
}

/** The original upload owner verifies bytes and retains the shared-file lease until settlement. */
export async function withManagedUpload<T>(store: Pick<AgentUploadStore, "withSharedFile">, reference: UploadReference,
  assertCurrent: () => void, operation: Operation<T>): Promise<T> {
  assertCurrent();
  return store.withSharedFile(reference.fileId, file => {
    if (file.sha256 !== reference.fileSha256) throw new Error("Managed file content does not match the upload receipt.");
    return useAttachment({ path: file.path, fileName: file.fileName, sha256: file.sha256, bytes: file.size }, assertCurrent, operation);
  });
}

/** The same role, plan and managed-file checks used by AgentSend. */
export function resolveManagedPlanAttachment(roleDirectory: (roleId: string) => string, reference: PlanReference): AttachmentFile {
  const roleId = sanitizeRoleId(reference.roleId ?? "");
  if (!roleId) throw new Error("A managed plan attachment requires the owning roleId.");
  const roleDir = roleDirectory(roleId);
  const plan = getPlan(roleDir, reference.planId);
  if (!plan) throw new Error(`Plan attachment plan was not found: ${reference.planId}.`);
  const attachment = plan.attachments.find(item => item.id === reference.attachmentId);
  if (!attachment) throw new Error(`Plan attachment was not found on plan ${reference.planId}: ${reference.attachmentId}.`);
  if (attachment.kind !== "image" && attachment.kind !== "file") {
    throw new Error(`Plan attachment ${reference.attachmentId} is not an image or file.`);
  }
  const realFile = resolvePlanAttachmentFile(roleDir, plan.id, attachment);
  return { path: realFile, fileName: attachment.name,
    sha256: attachment.sha256, bytes: attachment.size };
}

/** Retain verified plan bytes without holding a plan mutation lock across external I/O. */
async function withPlanReadCopy<T>(file: AttachmentFile, assertCurrent: () => void, operation: Operation<T>): Promise<T> {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > PLAN_ATTACHMENT_MAX_BYTES) {
    throw new Error("Managed plan attachment size is invalid.");
  }
  const content = Buffer.alloc(file.bytes);
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.bytes) throw new Error("Managed plan attachment changed.");
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw new Error("Managed plan attachment changed.");
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== file.bytes || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error("Managed plan attachment content does not match its storage record.");
    }
  } finally { await handle.close(); }
  assertCurrent();
  const directory = await mkdtemp(path.join(os.tmpdir(), "rabi-managed-attachment-"));
  const snapshot = path.join(directory, "content" + path.extname(file.fileName));
  try {
    await writeFile(snapshot, content, { flag: "wx", mode: 0o600 });
    return await useAttachment({ ...file, path: snapshot }, assertCurrent, operation);
  } finally {
    try {
      await unlink(snapshot).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      await rmdir(directory);
    } catch {
      // Cleanup must not reinterpret an acknowledged platform action as a failed action.
      console.warn("Could not release the managed plan attachment read copy.");
    }
  }
}

export function createManagedEndpointAttachmentPort(store: Pick<AgentUploadStore, "withSharedFile">,
  roleDirectory: (roleId: string) => string, assertNodeAuthorized: (source: TrustedLanAgentSource) => void): MessageEndpointManagedAttachmentPort {
  return async (request, reference, assertCurrent, operation) => {
    const authorize = () => {
      assertCurrent();
      if (!hasAuthenticatedConnectionRequest(request) && !isLoopbackRemoteAddress(request.socket.remoteAddress)) {
        throw new Error("Managed attachment access requires the original authorized Manager request.");
      }
      const source = getTrustedLanAgentSource(request);
      if (source) assertNodeAuthorized(source);
    };
    authorize();
    if (!validReference(reference)) throw new Error("Invalid managed attachment reference.");
    if ("fileId" in reference) return withManagedUpload(store, reference, authorize, operation);
    return withPlanReadCopy(resolveManagedPlanAttachment(roleDirectory, reference.planAttachment), authorize, operation);
  };
}

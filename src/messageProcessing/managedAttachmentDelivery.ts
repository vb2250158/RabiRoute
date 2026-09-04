import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type ManagedMessageImageInput = {
  id: string;
  path: string;
};

export type ManagedMessageImage = ManagedMessageImageInput & {
  path: string;
  contentHash: string;
};

export type ManagedMessageImageFailure = {
  id: string;
  path?: string;
  error: string;
};

export type ManagedMessageImageStageResult = {
  ready: ManagedMessageImage[];
  unavailable: ManagedMessageImageFailure[];
};

export type ManagedMessageImageBatch = {
  deliveryId: string;
  batchIndex: number;
  batchCount: number;
  prompt: string;
  imagePaths: string[];
};

const MANAGED_IMAGE_DIRECTORY = ".rabiroute-message-images";

function safePart(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 120);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
}

function ensureDirectoryWithoutLinks(directory: string, workspace: string): void {
  const relative = path.relative(workspace, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Managed image cache must stay inside the target workspace.");
  let current = workspace;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Managed image cache cannot use a symbolic link: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`Managed image cache path is not a directory: ${current}`);
    if (!stat) fs.mkdirSync(current);
  }
}

function contentHash(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function stageManagedMessageImages(input: {
  workspace: string;
  requirementId: string;
  attachments: ManagedMessageImageInput[];
}): ManagedMessageImageStageResult {
  const workspace = fs.realpathSync(path.resolve(input.workspace));
  const requirementPart = safePart(input.requirementId, "unknown-requirement");
  const managedRoot = path.join(workspace, MANAGED_IMAGE_DIRECTORY, requirementPart);
  ensureDirectoryWithoutLinks(managedRoot, workspace);
  const ready: ManagedMessageImage[] = [];
  const unavailable: ManagedMessageImageFailure[] = [];

  for (const attachment of input.attachments) {
    try {
      const sourcePath = fs.realpathSync(path.resolve(attachment.path));
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) throw new Error("Source attachment is not a file.");
      const hash = contentHash(sourcePath);
      const extension = path.extname(sourcePath).toLowerCase() || ".png";
      const attachmentPart = safePart(attachment.id, "image");
      const targetPath = path.join(managedRoot, `${attachmentPart}-${hash}${extension}`);
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        recordDataMutationAudit({
          group: "media",
          event: "managed_message_image_staged",
          owner: "managed-attachment-delivery",
          action: "stage-image",
          target: { type: "message-attachment", id: attachment.id },
          dataSource: { kind: "file", id: `${MANAGED_IMAGE_DIRECTORY}/${path.basename(targetPath)}` },
          outcome: "committed",
          after: { digest: hash }
        });
      } else {
        recordDataMutationAudit({
          group: "media",
          event: "managed_message_image_reused",
          owner: "managed-attachment-delivery",
          action: "stage-image",
          target: { type: "message-attachment", id: attachment.id },
          dataSource: { kind: "file", id: `${MANAGED_IMAGE_DIRECTORY}/${path.basename(targetPath)}` },
          outcome: "replayed",
          after: { digest: hash }
        });
      }
      ready.push({ id: attachment.id, path: targetPath, contentHash: hash });
    } catch (error) {
      recordDataMutationAudit({
        level: "warn",
        group: "media",
        event: "managed_message_image_stage_failed",
        owner: "managed-attachment-delivery",
        action: "stage-image",
        target: { type: "message-attachment", id: attachment.id },
        dataSource: { kind: "file", id: MANAGED_IMAGE_DIRECTORY },
        outcome: "failed",
        error
      });
      unavailable.push({
        id: attachment.id,
        path: attachment.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { ready, unavailable };
}

export function buildManagedMessageImageBatches(input: {
  requirementId: string;
  prompt: string;
  images: ManagedMessageImage[];
}): ManagedMessageImageBatch[] {
  const chunks: ManagedMessageImage[][] = [];
  for (let index = 0; index < input.images.length; index += 8) chunks.push(input.images.slice(index, index + 8));
  if (chunks.length === 0) chunks.push([]);
  const batchCount = chunks.length;
  return chunks.map((images, index) => {
    const batchIndex = index + 1;
    const digest = createHash("sha256")
      .update(JSON.stringify({ requirementId: input.requirementId, batchIndex, images: images.map((image) => [image.id, image.contentHash]) }))
      .digest("hex");
    const deliveryId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return {
      deliveryId,
      batchIndex,
      batchCount,
      prompt: `${batchIndex === 1 ? input.prompt : `[同一消息组第 ${batchIndex}/${batchCount} 批图片，无新增正文]`}\n\n本批投递 deliveryId：${deliveryId}`,
      imagePaths: images.map((image) => image.path)
    };
  });
}

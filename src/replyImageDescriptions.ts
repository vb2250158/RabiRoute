import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MessageAttachmentRecord } from "./history.js";
import type { AgentReplyOptions, AgentReplyRouteProfile, AgentReplyRuntime } from "./outbox.js";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";

export type ReplyImageDescriptionSend = {
  deliveryId: string;
  sender: {
    agentType: string;
    sessionId: string;
  };
  routeId: string;
  channel: string;
  target: {
    target?: unknown;
    groupId?: unknown;
    instanceId?: unknown;
    replyToMessageId?: unknown;
  };
  replyImageDescriptions: string[];
};

export type ReplyImageDescriptionArchive = {
  sourceMessageId: string;
  files: Array<{
    attachmentId: string;
    imageFile: string;
    descriptionFile: string;
  }>;
};

export type ReplyImageDescriptionPlan = {
  deliveryId: string;
  sender: ReplyImageDescriptionSend["sender"];
  routeId: string;
  sourceMessageId: string;
  groupId: string;
  items: Array<{
    attachmentId: string;
    imagePath: string;
    descriptionPath: string;
    description: string;
  }>;
};

type ResolvedRoute = {
  runtime: AgentReplyRuntime;
  profile?: AgentReplyRouteProfile;
};

type LocatedMessage = {
  record: Record<string, unknown>;
  dataDirs: string[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function routeConfigName(runtimeId: string): string {
  const parts = runtimeId.split("__");
  return parts[1] || runtimeId;
}

function roleDir(rootDir: string, rolesRoot: string, item: { rolesDir?: string; agentRoleId?: string }): string | undefined {
  const roleId = text(item.agentRoleId);
  if (!roleId) return undefined;
  return path.join(path.resolve(rootDir, item.rolesDir ?? rolesRoot), roleId);
}

function resolveRoute(options: AgentReplyOptions, routeId: string): ResolvedRoute | undefined {
  for (const runtime of options.runtimes) {
    if (runtime.enabled === false) continue;
    const profile = runtime.routeProfiles?.find((item) => item.id === routeId && item.enabled !== false);
    if (profile) return { runtime, profile };
    if (runtime.id === routeId || runtime.configName === routeId) {
      if ((runtime.routeProfiles?.length ?? 0) > 1) return undefined;
      const onlyProfile = runtime.routeProfiles?.[0];
      if (onlyProfile?.enabled === false) return undefined;
      return { runtime, profile: onlyProfile };
    }
  }
  return undefined;
}

function dataDirsForRoute(options: AgentReplyOptions, route: ResolvedRoute): string[] {
  const output = new Set<string>();
  output.add(path.resolve(options.routeRoot, routeConfigName(route.runtime.id)));
  if (route.runtime.dataDir) output.add(path.resolve(options.rootDir, route.runtime.dataDir));
  const runtimeRoleDir = roleDir(options.rootDir, options.rolesRoot, route.runtime);
  if (runtimeRoleDir) output.add(runtimeRoleDir);
  if (route.profile?.dataDir) output.add(path.resolve(options.rootDir, route.profile.dataDir));
  if (route.profile) {
    const profileRoleDir = roleDir(options.rootDir, options.rolesRoot, {
      rolesDir: route.profile.rolesDir ?? route.runtime.rolesDir,
      agentRoleId: route.profile.agentRoleId ?? route.runtime.agentRoleId
    });
    if (profileRoleDir) output.add(profileRoleDir);
  }
  return [...output];
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function locateMessage(
  options: AgentReplyOptions,
  routeId: string,
  messageId: string,
  groupId: string,
  instanceId: string
): LocatedMessage | undefined {
  const route = resolveRoute(options, routeId);
  if (!route) throw new Error(`Cannot resolve the exact enabled routeId ${routeId} while checking the referenced QQ message.`);
  const dataDirs = dataDirsForRoute(options, route);
  const allowLegacyMissingInstance = (route.runtime.napcatInstances ?? []).filter((item) => item.enabled !== false).length <= 1;
  const candidates = dataDirs.flatMap((dataDir) => readJsonl(path.join(dataDir, "group-messages.jsonl"))
    .filter((record) => text(record.messageId ?? record.message_id) === messageId)
    .filter((record) => !groupId || text(record.groupId ?? record.group_id) === groupId)
    .filter((record) => !instanceId
      || text(record.instanceId) === instanceId
      || (!text(record.instanceId) && allowLegacyMissingInstance))
    .map((record, index) => ({ record, index, time: Number(record.time ?? 0) })));
  const found = candidates.sort((left, right) => right.time - left.time || right.index - left.index)[0];
  return found ? { record: found.record, dataDirs } : undefined;
}

function imageSegmentCount(record: Record<string, unknown>): number {
  const structured = Array.isArray(record.segments)
    ? record.segments.filter((segment) => segment && typeof segment === "object" && !Array.isArray(segment)
      && text((segment as Record<string, unknown>).type).toLowerCase() === "image").length
    : 0;
  const cq = [...text(record.rawMessage).matchAll(/\[CQ:image\b[^\]]*\]/gi)].length;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.filter((item) => item && typeof item === "object" && !Array.isArray(item)
      && text((item as Record<string, unknown>).kind).toLowerCase() === "image").length
    : 0;
  return Math.max(structured, cq, attachments);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readableImages(record: Record<string, unknown>, dataDirs: string[], imageCount: number): Array<{ id: string; path: string }> {
  const attachments = (Array.isArray(record.attachments) ? record.attachments : [])
    .flatMap((raw): MessageAttachmentRecord[] => raw && typeof raw === "object" && !Array.isArray(raw)
      ? [raw as MessageAttachmentRecord]
      : [])
    .filter((item) => item.kind === "image");
  const mediaRoots = dataDirs.map((dataDir) => path.resolve(dataDir, "napcat-media"));
  const output: Array<{ id: string; path: string }> = [];
  for (let index = 0; index < imageCount; index += 1) {
    const attachment = attachments[index];
    const rawPath = text(attachment?.path);
    if (attachment?.status !== "ready" || !rawPath || !fs.existsSync(rawPath) || !fs.statSync(rawPath).isFile()) {
      throw new Error(
        `Referenced image ${index + 1} of ${imageCount} is not readable. `
        + "Retry fetching the QQ image or hand the message off; RabiRoute cannot send a reply based on a guessed description."
      );
    }
    const imagePath = fs.realpathSync(path.resolve(rawPath));
    const allowed = mediaRoots.some((root) => isPathWithin(path.resolve(root), imagePath));
    if (!allowed) {
      throw new Error(`Referenced image ${index + 1} is outside the managed napcat-media directories and cannot be described safely.`);
    }
    const parsed = path.parse(imagePath);
    output.push({
      id: text(attachment.id) || `${text(record.messageId)}:image:${index + 1}`,
      path: imagePath
    });
    if (!parsed.name) throw new Error(`Referenced image ${index + 1} has no stable file name.`);
  }
  return output;
}

function concreteDescription(value: string, index: number): string {
  const normalized = text(value).replace(/\s+/g, " ");
  const generic = /^(?:已?查看|看过了?|图片|图里内容|同上|无|没有|不清楚|不知道|见图|ok|okay)$/i;
  if (normalized.length < 4 || generic.test(normalized)) {
    throw new Error(
      `params.replyImageDescriptions[${index}] must state the actual image content and meaning; `
      + "generic confirmations such as '已查看' are not accepted."
    );
  }
  if (normalized.length > 5_000) throw new Error(`params.replyImageDescriptions[${index}] exceeds 5000 characters.`);
  return normalized;
}

export function prepareReplyImageDescriptions(
  input: ReplyImageDescriptionSend,
  options: AgentReplyOptions
): ReplyImageDescriptionPlan | undefined {
  if (input.channel !== "napcat" || text(input.target.target) !== "group") return undefined;
  const replyToMessageId = text(input.target.replyToMessageId);
  if (!replyToMessageId) {
    if (input.replyImageDescriptions.length > 0) {
      throw new Error("params.replyImageDescriptions must be empty when params.replyToMessageId is empty.");
    }
    return undefined;
  }
  const groupId = text(input.target.groupId);
  const instanceId = text(input.target.instanceId);
  const located = locateMessage(options, input.routeId, replyToMessageId, groupId, instanceId);
  if (!located) {
    throw new Error(
      `Referenced QQ message ${replyToMessageId} was not found in the selected Route history. `
      + "RabiRoute cannot verify whether it contains images, so fetch the source message before sending."
    );
  }
  const imageCount = imageSegmentCount(located.record);
  if (imageCount === 0) {
    if (input.replyImageDescriptions.length > 0) {
      throw new Error("params.replyImageDescriptions must be empty because the referenced QQ message contains no images.");
    }
    return undefined;
  }
  if (input.replyImageDescriptions.length !== imageCount) {
    throw new Error(
      `params.replyImageDescriptions must contain ${imageCount} descriptions, one for each image in the referenced QQ message; `
      + `received ${input.replyImageDescriptions.length}. Preserve the original image order.`
    );
  }
  const images = readableImages(located.record, located.dataDirs, imageCount);
  return {
    deliveryId: input.deliveryId,
    sender: input.sender,
    routeId: input.routeId,
    sourceMessageId: replyToMessageId,
    groupId,
    items: images.map((image, index) => ({
      attachmentId: image.id,
      imagePath: image.path,
      descriptionPath: path.join(path.dirname(image.path), `${path.parse(image.path).name}.md`),
      description: concreteDescription(input.replyImageDescriptions[index]!, index)
    }))
  };
}

function markdownLine(value: unknown): string {
  return text(value).replace(/[\r\n]+/g, " ");
}

export function archiveReplyImageDescriptions(
  plan: ReplyImageDescriptionPlan,
  options: { rootDir: string; sentMessageId?: string }
): ReplyImageDescriptionArchive {
  const markerHash = createHash("sha256").update(plan.deliveryId, "utf8").digest("hex");
  const marker = `<!-- rabiroute-image-description:${markerHash} -->`;
  const now = new Date().toISOString();
  const files = plan.items.map((item, index) => {
    const relativeImage = path.relative(options.rootDir, item.imagePath).replaceAll(path.sep, "/");
    const relativeDescription = path.relative(options.rootDir, item.descriptionPath).replaceAll(path.sep, "/");
    const section = [
      marker,
      `## ${now}`,
      "",
      `- 来源消息 ID：${markdownLine(plan.sourceMessageId)}`,
      `- 图片序号：${index + 1}/${plan.items.length}`,
      `- 图片文件：${markdownLine(path.basename(item.imagePath))}`,
      `- 附件 ID：${markdownLine(item.attachmentId)}`,
      `- Route：${markdownLine(plan.routeId)}`,
      `- Agent 类型：${markdownLine(plan.sender.agentType)}`,
      `- Agent 会话 ID：${markdownLine(plan.sender.sessionId)}`,
      `- 发送 ID：${markdownLine(plan.deliveryId)}`,
      `- QQ 发送消息 ID：${markdownLine(options.sentMessageId) || "未返回"}`,
      "",
      "### Agent 了解到的信息",
      "",
      item.description,
      ""
    ].join("\n");
    withFileLockSync(`${item.descriptionPath}.lock`, () => {
      const existing = fs.existsSync(item.descriptionPath) ? fs.readFileSync(item.descriptionPath, "utf8") : "";
      if (existing.includes(marker)) return;
      const prefix = existing.trim()
        ? `${existing.trimEnd()}\n\n`
        : `# 图片说明\n\n- 对应图片：${markdownLine(path.basename(item.imagePath))}\n- Rabi 相对路径：${markdownLine(relativeImage)}\n\n`;
      atomicWriteFileSync(item.descriptionPath, `${prefix}${section}\n`);
    });
    return {
      attachmentId: item.attachmentId,
      imageFile: relativeImage,
      descriptionFile: relativeDescription
    };
  });
  return { sourceMessageId: plan.sourceMessageId, files };
}

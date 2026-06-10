import fs from "node:fs";
import path from "node:path";

export type RolePanelAttachment = {
  kind: "file" | "image" | "voice";
  name?: string;
  path?: string;
  url?: string;
  size?: number;
};

export type RolePanelTimelineMessage = {
  id: string;
  time: number;
  roleId: string;
  gatewayId?: string;
  routeProfileId?: string;
  direction: "user" | "assistant" | "system";
  sender: string;
  text: string;
  attachments: RolePanelAttachment[];
  status: "pending" | "sent" | "failed" | "draft";
  replyContext?: Record<string, unknown>;
};

export function rolePanelDir(roleDir: string): string {
  return path.join(roleDir, "role-panel");
}

export function rolePanelMessagesPath(roleDir: string): string {
  return path.join(rolePanelDir(roleDir), "messages.jsonl");
}

export function createRolePanelMessageId(prefix = "role-panel"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeRolePanelAttachments(value: unknown): RolePanelAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const kind = raw.kind === "image" || raw.kind === "voice" ? raw.kind : "file";
    const name = stringValue(raw.name);
    const filePath = stringValue(raw.path);
    const url = stringValue(raw.url);
    if (!name && !filePath && !url) return [];
    const size = Number(raw.size);
    return [{
      kind,
      name,
      path: filePath,
      url,
      size: Number.isFinite(size) && size >= 0 ? size : undefined
    }];
  });
}

export function appendRolePanelTimelineMessage(roleDir: string, message: RolePanelTimelineMessage): RolePanelTimelineMessage {
  const normalized: RolePanelTimelineMessage = {
    ...message,
    attachments: normalizeRolePanelAttachments(message.attachments),
    time: Number.isFinite(message.time) && message.time > 0 ? message.time : Math.floor(Date.now() / 1000),
    status: message.status || "sent"
  };
  fs.mkdirSync(rolePanelDir(roleDir), { recursive: true });
  fs.appendFileSync(rolePanelMessagesPath(roleDir), `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export function readRolePanelTimeline(roleDir: string, limit = 120): RolePanelTimelineMessage[] {
  const filePath = rolePanelMessagesPath(roleDir);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, limit)).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const raw = parsed as Partial<RolePanelTimelineMessage>;
      return [{
        id: stringValue(raw.id) || createRolePanelMessageId(),
        time: Number(raw.time) || 0,
        roleId: stringValue(raw.roleId) || "",
        gatewayId: stringValue(raw.gatewayId),
        routeProfileId: stringValue(raw.routeProfileId),
        direction: raw.direction === "assistant" || raw.direction === "system" ? raw.direction : "user",
        sender: stringValue(raw.sender) || "",
        text: stringValue(raw.text) || "",
        attachments: normalizeRolePanelAttachments(raw.attachments),
        status: raw.status === "pending" || raw.status === "failed" || raw.status === "draft" ? raw.status : "sent",
        replyContext: raw.replyContext && typeof raw.replyContext === "object" && !Array.isArray(raw.replyContext)
          ? raw.replyContext as Record<string, unknown>
          : undefined
      }];
    } catch {
      return [];
    }
  });
}

function stringValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

import { config, type NapCatInstanceConfig } from "./config.js";

const GROUP_FILE_RESPONSE_BYTES = 256 * 1024;
const GROUP_FILE_PAGE_ENTRIES = 50;
const GROUP_FILE_FIELD_CHARS = 256;

export type GroupFileMetadata = { fileId: string; fileName: string; fileSize?: number; uploadTime?: number; uploader?: string; busid?: number };
export type GroupFolderMetadata = { folderId: string; folderName: string; totalFileCount?: number };
export type GroupFilesPage = {
  files: GroupFileMetadata[];
  folders: GroupFolderMetadata[];
  completenessUnknown: true;
  potentiallyTruncated: true;
  projectionTruncated: boolean;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function bounded(value: unknown, max = GROUP_FILE_FIELD_CHARS): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A single bounded projection, not a paginated or exhaustive directory listing. */
export function parseNapCatGroupFiles(value: unknown): GroupFilesPage {
  const envelope = object(value);
  if (!envelope || envelope.status !== "ok" || envelope.retcode !== 0) throw new Error("Invalid group file envelope");
  const data = object(envelope.data);
  if (!data || !Array.isArray(data.files) || !Array.isArray(data.folders)) throw new Error("Invalid group file data");
  const files: GroupFileMetadata[] = [];
  const folders: GroupFolderMetadata[] = [];
  for (const entry of data.files.slice(0, GROUP_FILE_PAGE_ENTRIES)) {
    const file = object(entry);
    const fileId = bounded(file?.file_id);
    const fileName = bounded(file?.file_name);
    if (!fileId || !fileName) continue;
    files.push({ fileId, fileName, fileSize: nonnegative(file?.file_size), uploadTime: nonnegative(file?.upload_time),
      uploader: typeof file?.uploader === "number" && Number.isSafeInteger(file.uploader) && file.uploader >= 0 ? String(file.uploader) : bounded(file?.uploader, 32),
      busid: nonnegative(file?.busid) });
  }
  for (const entry of data.folders.slice(0, GROUP_FILE_PAGE_ENTRIES - files.length)) {
    const folder = object(entry);
    const folderId = bounded(folder?.folder_id);
    const folderName = bounded(folder?.folder_name);
    if (!folderId || !folderName) continue;
    folders.push({ folderId, folderName, totalFileCount: nonnegative(folder?.total_file_count) });
  }
  return { files, folders, completenessUnknown: true, potentiallyTruncated: true,
    projectionTruncated: data.files.length > GROUP_FILE_PAGE_ENTRIES || data.folders.length > GROUP_FILE_PAGE_ENTRIES - files.length };
}

/** Only the two documented read actions; no generic action dispatch, redirect, download or token-bearing error. */
export async function readNapCatGroupFiles(endpoint: NapCatEndpoint, groupId: string, folderId?: string, transport: typeof fetch = fetch): Promise<GroupFilesPage> {
  const action = folderId === undefined ? "get_group_root_files" : "get_group_files_by_folder";
  const response = await transport(`${endpoint.httpUrl}/${action}`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json; charset=utf-8", ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}) },
    body: JSON.stringify({ group_id: groupId, ...(folderId === undefined ? {} : { folder_id: folderId }), file_count: GROUP_FILE_PAGE_ENTRIES })
  });
  if (!response.ok || Number(response.headers.get("content-length")) > GROUP_FILE_RESPONSE_BYTES || !response.body) throw new Error("Group file upstream unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GROUP_FILE_RESPONSE_BYTES) throw new Error("Group file response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return parseNapCatGroupFiles(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
}


export type OneBotMessageSegment = {
  type: string;
  data: Record<string, unknown>;
};

export type OneBotMessage = string | OneBotMessageSegment[];

type SendGroupMessageParams = {
  groupId: number | string;
  message: OneBotMessage;
};

type SendPrivateMessageParams = {
  userId: number | string;
  message: OneBotMessage;
};

type UploadGroupFileParams = {
  groupId: number | string;
  filePath: string;
  fileName: string;
  folderId?: string;
};

type OneBotResponse<T> = {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: T;
};

type SendMessageResult = {
  messageId?: number | string;
};

export type UploadGroupFileResult = {
  fileId?: string;
  fileName?: string;
};

export type NapCatEndpoint = Pick<NapCatInstanceConfig, "httpUrl" | "accessToken">;

export type LoginInfo = {
  userId?: number | string;
  nickname?: string;
};

export type BotStatus = {
  online?: boolean;
  good?: boolean;
};

export type ForwardMessageNode = {
  self_id?: number | string;
  user_id?: number | string;
  time?: number;
  message_id?: number | string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
  };
  raw_message?: string;
  message?: OneBotMessage;
};

export type ForwardMessageResult = {
  messages: ForwardMessageNode[];
};

type CallNapCatOptions = {
  timeoutMs?: number;
};

export type MessageInfo = {
  selfId?: number | string;
  userId?: number | string;
  time?: number;
  messageId?: number | string;
  messageType?: string;
  groupId?: number | string;
  senderName?: string;
  rawMessage: string;
  message: OneBotMessage;
};

function endpointConfig(endpoint?: NapCatEndpoint): NapCatEndpoint {
  return {
    httpUrl: endpoint?.httpUrl || config.napcatHttpUrl,
    accessToken: endpoint?.accessToken ?? config.napcatAccessToken
  };
}

export async function callNapCat<T>(action: string, payload: unknown, endpoint?: NapCatEndpoint, options?: CallNapCatOptions): Promise<T> {
  const target = endpointConfig(endpoint);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8"
  };

  if (target.accessToken) {
    headers.authorization = `Bearer ${target.accessToken}`;
  }

  const controller = options?.timeoutMs ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), options?.timeoutMs)
    : undefined;
  let response: Response;
  try {
    response = await fetch(`${target.httpUrl.replace(/\/$/, "")}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NapCat ${action} failed: HTTP ${response.status} ${text}`);
  }

  const parsed = text ? (JSON.parse(text) as OneBotResponse<T> | T) : ({} as T);
  if (parsed && typeof parsed === "object" && ("retcode" in parsed || "status" in parsed)) {
    const result = parsed as OneBotResponse<T>;
    if ((result.retcode != null && result.retcode !== 0) || result.status === "failed") {
      const detail = result.wording || result.message || text;
      throw new Error(`NapCat ${action} failed: retcode=${result.retcode ?? "unknown"} status=${result.status ?? "unknown"} ${detail}`);
    }
  }

  return parsed as T;
}

export async function getLoginInfo(endpoint?: NapCatEndpoint): Promise<LoginInfo> {
  const response = await callNapCat<OneBotResponse<{ user_id?: number | string; nickname?: string }> | { user_id?: number | string; nickname?: string }>("get_login_info", {}, endpoint);
  const data: { user_id?: number | string; nickname?: string } =
    "data" in response && response.data ? response.data : response as { user_id?: number | string; nickname?: string };
  return {
    userId: data.user_id,
    nickname: data.nickname
  };
}

export async function getStatus(endpoint?: NapCatEndpoint): Promise<BotStatus> {
  const response = await callNapCat<OneBotResponse<{ online?: boolean; good?: boolean }> | { online?: boolean; good?: boolean }>("get_status", {}, endpoint);
  const data: { online?: boolean; good?: boolean } =
    "data" in response && response.data ? response.data : response as { online?: boolean; good?: boolean };
  return {
    online: data.online,
    good: data.good
  };
}

export async function getForwardMessage(messageId: number | string, endpoint?: NapCatEndpoint): Promise<ForwardMessageResult> {
  const response = await callNapCat<OneBotResponse<ForwardMessageResult> | ForwardMessageResult>("get_forward_msg", {
    message_id: messageId
  }, endpoint);
  const data = "data" in response && response.data ? response.data : response as ForwardMessageResult;
  return {
    messages: Array.isArray(data.messages) ? data.messages : []
  };
}

function rawMessageFromSegments(message: OneBotMessage): string {
  if (typeof message === "string") return message;

  return message.map((segment) => {
    if (segment.type === "text") {
      return String(segment.data.text ?? "");
    }

    const params = Object.entries(segment.data)
      .map(([key, value]) => `${key}=${String(value ?? "")}`)
      .join(",");
    return `[CQ:${segment.type}${params ? `,${params}` : ""}]`;
  }).join("");
}

export async function getMessage(messageId: number | string, endpoint?: NapCatEndpoint): Promise<MessageInfo> {
  type GetMessageData = {
    self_id?: number | string;
    user_id?: number | string;
    time?: number;
    message_id?: number | string;
    message_type?: string;
    group_id?: number | string;
    sender?: {
      user_id?: number | string;
      nickname?: string;
      card?: string;
    };
    raw_message?: string;
    message?: OneBotMessage;
  };

  const response = await callNapCat<OneBotResponse<GetMessageData> | GetMessageData>("get_msg", {
    message_id: messageId
  }, endpoint, { timeoutMs: 3_000 });
  const data = "data" in response && response.data ? response.data : response as GetMessageData;
  const message = data.message ?? data.raw_message ?? "";
  return {
    selfId: data.self_id,
    userId: data.user_id ?? data.sender?.user_id,
    time: data.time,
    messageId: data.message_id ?? messageId,
    messageType: data.message_type,
    groupId: data.group_id,
    senderName: data.sender?.card || data.sender?.nickname,
    rawMessage: data.raw_message ?? rawMessageFromSegments(message),
    message
  };
}

function normalizeSendMessageResult(response: OneBotResponse<{ message_id?: number | string }> | { message_id?: number | string }): SendMessageResult {
  const wrapped = response as OneBotResponse<{ message_id?: number | string }>;
  const data = wrapped.data ?? (response as { message_id?: number | string });
  return {
    messageId: data.message_id
  };
}

export async function sendGroupMessage(params: SendGroupMessageParams, endpoint?: NapCatEndpoint): Promise<SendMessageResult> {
  const response = await callNapCat<OneBotResponse<{ message_id?: number | string }> | { message_id?: number | string }>("send_group_msg", {
    group_id: Number(params.groupId),
    message: params.message
  }, endpoint);
  return normalizeSendMessageResult(response);
}

export async function sendPrivateMessage(params: SendPrivateMessageParams, endpoint?: NapCatEndpoint): Promise<SendMessageResult> {
  const response = await callNapCat<OneBotResponse<{ message_id?: number | string }> | { message_id?: number | string }>("send_private_msg", {
    user_id: Number(params.userId),
    message: params.message
  }, endpoint);
  return normalizeSendMessageResult(response);
}

export async function uploadGroupFile(params: UploadGroupFileParams, endpoint?: NapCatEndpoint): Promise<UploadGroupFileResult> {
  const response = await callNapCat<OneBotResponse<Record<string, unknown>> | Record<string, unknown>>("upload_group_file", {
    group_id: Number(params.groupId),
    file: params.filePath,
    name: params.fileName,
    ...(params.folderId ? { folder: params.folderId } : {})
  }, endpoint);
  const wrapped = response as OneBotResponse<Record<string, unknown>>;
  const data = wrapped.data ?? response as Record<string, unknown>;
  return {
    fileId: data && typeof data === "object" ? String(data.file_id ?? data.id ?? "").trim() || undefined : undefined,
    fileName: data && typeof data === "object" ? String(data.file_name ?? data.name ?? params.fileName).trim() || params.fileName : params.fileName
  };
}

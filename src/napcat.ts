import { config, type NapCatInstanceConfig } from "./config.js";

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

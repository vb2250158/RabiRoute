import { config, type NapCatInstanceConfig } from "./config.js";

export type OneBotMessageSegment = {
  type: "text" | "image" | "record" | "file";
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

export type NapCatEndpoint = Pick<NapCatInstanceConfig, "httpUrl" | "accessToken">;

export type LoginInfo = {
  userId?: number | string;
  nickname?: string;
};

export type BotStatus = {
  online?: boolean;
  good?: boolean;
};

function endpointConfig(endpoint?: NapCatEndpoint): NapCatEndpoint {
  return {
    httpUrl: endpoint?.httpUrl || config.napcatHttpUrl,
    accessToken: endpoint?.accessToken ?? config.napcatAccessToken
  };
}

export async function callNapCat<T>(action: string, payload: unknown, endpoint?: NapCatEndpoint): Promise<T> {
  const target = endpointConfig(endpoint);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8"
  };

  if (target.accessToken) {
    headers.authorization = `Bearer ${target.accessToken}`;
  }

  const response = await fetch(`${target.httpUrl.replace(/\/$/, "")}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

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

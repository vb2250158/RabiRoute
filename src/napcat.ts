import { config } from "./config.js";

type SendGroupMessageParams = {
  groupId: number | string;
  message: string;
};

type SendPrivateMessageParams = {
  userId: number | string;
  message: string;
};

export async function callNapCat<T>(action: string, payload: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (config.napcatAccessToken) {
    headers.authorization = `Bearer ${config.napcatAccessToken}`;
  }

  const response = await fetch(`${config.napcatHttpUrl.replace(/\/$/, "")}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NapCat ${action} failed: HTTP ${response.status} ${text}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function sendGroupMessage(params: SendGroupMessageParams): Promise<void> {
  await callNapCat("send_group_msg", {
    group_id: Number(params.groupId),
    message: params.message
  });
}

export async function sendPrivateMessage(params: SendPrivateMessageParams): Promise<void> {
  await callNapCat("send_private_msg", {
    user_id: Number(params.userId),
    message: params.message
  });
}

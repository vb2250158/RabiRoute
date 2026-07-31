export type FeishuEndpoint = { appId: string; appSecret: string };

export async function sendFeishuText(endpoint: FeishuEndpoint, chatId: string, text: string): Promise<{ messageId?: string }> {
  if (!endpoint.appId || !endpoint.appSecret || !chatId || !text.trim()) throw new Error("Feishu app credentials, chat id and text are required.");
  const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: endpoint.appId, app_secret: endpoint.appSecret }), signal: AbortSignal.timeout(10_000)
  });
  const tokenBody = await tokenResponse.json() as { code?: number; tenant_access_token?: string };
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) throw new Error("Feishu tenant access token request failed.");
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenBody.tenant_access_token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }), signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json() as { code?: number; data?: { message_id?: string } };
  if (!response.ok || body.code !== 0) throw new Error("Feishu message API rejected the reply.");
  return { messageId: body.data?.message_id };
}

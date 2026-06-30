import fs from "node:fs";
import path from "node:path";
import AiBot, {
  generateReqId,
  type BaseMessage,
  type SendMsgBody,
  type TemplateCard,
  type WeComMediaType,
  type WSClient,
  type WSClientOptions,
  type WsFrame,
  type WsFrameHeaders
} from "@wecom/aibot-node-sdk";

export type WeComEndpoint = {
  botId: string;
  secret: string;
  wsUrl?: string;
};

export type WeComSendParams = {
  chatId: string;
  text?: string;
  markdown?: string;
  payloadType?: "text" | "image" | "voice" | "file" | "template_card";
  filePath?: string;
  fileUrl?: string;
  fileName?: string;
  templateCard?: TemplateCard | Record<string, unknown>;
};

export type WeComSendResult = {
  messageId?: string;
  reqId?: string;
  raw?: unknown;
};

export type WeComClientLike = Pick<WSClient, "connect" | "disconnect" | "on" | "sendMessage" | "replyStream" | "uploadMedia" | "sendMediaMessage" | "replyMedia"> & {
  readonly isConnected?: boolean;
};

let clientFactory: (options: WSClientOptions) => WeComClientLike = (options) => new AiBot.WSClient(options);
const clientCache = new Map<string, WeComClientLike>();

export function setWeComClientFactory(factory: (options: WSClientOptions) => WeComClientLike): void {
  clientFactory = factory;
  clientCache.clear();
}

export function resetWeComClientFactory(): void {
  clientFactory = (options) => new AiBot.WSClient(options);
  clientCache.clear();
}

export function normalizeWeComError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function endpointKey(endpoint: WeComEndpoint): string {
  return `${endpoint.botId}\n${endpoint.wsUrl || ""}`;
}

export function assertWeComEndpoint(endpoint: Partial<WeComEndpoint>): asserts endpoint is WeComEndpoint {
  if (!endpoint.botId?.trim()) {
    throw new Error("Missing WeCom bot id.");
  }
  if (!endpoint.secret?.trim()) {
    throw new Error("Missing WeCom bot secret.");
  }
}

export function createWeComClient(endpoint: WeComEndpoint, options: Partial<WSClientOptions> = {}): WeComClientLike {
  assertWeComEndpoint(endpoint);
  return clientFactory({
    botId: endpoint.botId,
    secret: endpoint.secret,
    wsUrl: endpoint.wsUrl || undefined,
    maxReconnectAttempts: -1,
    ...options
  });
}

function cachedClient(endpoint: WeComEndpoint): WeComClientLike {
  assertWeComEndpoint(endpoint);
  const key = endpointKey(endpoint);
  const current = clientCache.get(key);
  if (current) {
    return current;
  }
  const client = createWeComClient(endpoint);
  client.connect();
  clientCache.set(key, client);
  return client;
}

function frameResult(frame: unknown): WeComSendResult {
  const item = frame as WsFrame | undefined;
  return {
    reqId: item?.headers?.req_id,
    messageId: (item?.body as Record<string, unknown> | undefined)?.msgid as string | undefined,
    raw: frame
  };
}

function textBody(params: WeComSendParams): SendMsgBody {
  const content = params.markdown || params.text || "";
  if (!content.trim()) {
    throw new Error("Missing WeCom message text.");
  }
  return {
    msgtype: "markdown",
    markdown: { content }
  } as SendMsgBody;
}

function mediaTypeFor(kind: string): WeComMediaType {
  if (kind === "image" || kind === "voice" || kind === "file") {
    return kind;
  }
  throw new Error(`Unsupported WeCom media type: ${kind}`);
}

async function readMediaBuffer(params: WeComSendParams): Promise<{ buffer: Buffer; filename: string }> {
  if (params.filePath) {
    const resolved = path.resolve(params.filePath);
    return {
      buffer: await fs.promises.readFile(resolved),
      filename: params.fileName || path.basename(resolved)
    };
  }
  if (params.fileUrl) {
    const response = await fetch(params.fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download WeCom media: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      filename: params.fileName || params.fileUrl.split("/").pop() || "wecom-media"
    };
  }
  throw new Error("Missing WeCom media file path/url.");
}

export async function sendWeComMessage(endpoint: WeComEndpoint, params: WeComSendParams): Promise<WeComSendResult> {
  if (!params.chatId?.trim()) {
    throw new Error("Missing WeCom chat id.");
  }
  const client = cachedClient(endpoint);
  const kind = params.payloadType || "text";
  if (kind === "template_card") {
    if (!params.templateCard) {
      throw new Error("Missing WeCom template card payload.");
    }
    const frame = await client.sendMessage(params.chatId, {
      msgtype: "template_card",
      template_card: params.templateCard
    } as SendMsgBody);
    return frameResult(frame);
  }
  if (kind === "image" || kind === "voice" || kind === "file") {
    const media = await readMediaBuffer(params);
    const uploaded = await client.uploadMedia(media.buffer, {
      type: mediaTypeFor(kind),
      filename: media.filename
    });
    const frame = await client.sendMediaMessage(params.chatId, mediaTypeFor(kind), uploaded.media_id);
    return frameResult(frame);
  }
  const frame = await client.sendMessage(params.chatId, textBody(params));
  return frameResult(frame);
}

export async function replyWeComMessage(endpoint: WeComEndpoint, frame: WsFrameHeaders, text: string): Promise<WeComSendResult> {
  if (!text.trim()) {
    throw new Error("Missing WeCom reply text.");
  }
  const client = cachedClient(endpoint);
  const result = await client.replyStream(frame, generateReqId("rabiroute"), text, true);
  return frameResult(result);
}

export function textFromWeComMessage(message: BaseMessage): string {
  if (message.msgtype === "text") {
    return String(message.text?.content ?? "");
  }
  if (message.msgtype === "voice") {
    return String(message.voice?.content ?? "");
  }
  if (message.msgtype === "mixed") {
    return (message.mixed?.msg_item ?? [])
      .map((item: { msgtype?: string; text?: { content?: string } }) => item.msgtype === "text" ? item.text?.content ?? "" : "[image]")
      .join("");
  }
  if (message.msgtype === "image") return "[image]";
  if (message.msgtype === "file") return "[file]";
  if (message.msgtype === "video") return "[video]";
  return "";
}

export function quoteTextFromWeComMessage(message: BaseMessage): string | undefined {
  const quote = message.quote;
  if (!quote) return undefined;
  if (quote.msgtype === "text") return quote.text?.content;
  if (quote.msgtype === "voice") return quote.voice?.content;
  if (quote.msgtype === "mixed") {
    return (quote.mixed?.msg_item ?? []).map((item: { msgtype?: string; text?: { content?: string } }) => item.msgtype === "text" ? item.text?.content ?? "" : "[image]").join("");
  }
  if (quote.msgtype === "image") return "[image]";
  if (quote.msgtype === "file") return "[file]";
  return undefined;
}

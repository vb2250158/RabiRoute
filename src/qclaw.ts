import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ── Conversation history cache ──
// Map<sessionKey, Array<{ role, content }>>
const historyCache = new Map<string, Array<{ role: string; content: string }>>();
const MAX_HISTORY = 40; // max total messages (user + assistant) per session
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min idle → clear
const historyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionKey(userId: number, groupId?: number): string {
  return groupId ? `grp-${groupId}` : `pm-${userId}`;
}

function resetHistoryTimer(key: string): void {
  const old = historyTimers.get(key);
  if (old) clearTimeout(old);
  historyTimers.set(key, setTimeout(() => {
    historyCache.delete(key);
    historyTimers.delete(key);
  }, HISTORY_TTL_MS));
}

/**
 * Load recent messages from the JSONL log (mimics Codex reading {logPath}).
 * Returns the last `count` records formatted as conversation turns.
 */
function loadRecentFromLog(
  filePath: string,
  count: number,
  botNickname: string
): Array<{ role: string; content: string }> {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return [];

    const recent = lines.slice(-count);
    const turns: Array<{ role: string; content: string }> = [];
    for (const line of recent) {
      try {
        const record = JSON.parse(line) as {
          rawMessage: string;
          senderName?: string;
          userId?: number | string;
        };
        const sender = record.senderName || record.userId || "unknown";
        const text = String(record.rawMessage ?? "").trim();
        if (!text) continue;
        // Treat every message as "user" (we don't log bot replies in the same file yet)
        turns.push({ role: "user", content: `[${sender}]: ${text}` });
      } catch {
        // skip malformed JSON lines
      }
    }
    return turns;
  } catch {
    return [];
  }
}

type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
};

let notificationQueue: Promise<string | null> = Promise.resolve(null);

async function callQClawChatCompletion(messages: Array<{ role: string; content: string }>): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (config.qclawGatewayToken) {
    headers.authorization = `Bearer ${config.qclawGatewayToken}`;
  }

  const body = {
    model: config.qclawModel,
    messages,
    max_tokens: 2000
  };

  const url = `${config.qclawGatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`QClaw API error: HTTP ${response.status} ${text}`);
  }

  const data = JSON.parse(text) as ChatCompletionResponse;
  if (data.error) {
    throw new Error(`QClaw API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("QClaw returned empty response");
  }

  return content;
}

/**
 * Build a system prompt for the QQ bot context.
 */
function buildSystemPrompt(): string {
  return [
    `你是 ${config.botNickname}，一个运行在 QQ 群聊和私聊里的 AI 助手。`,
    "你是通过 QClaw (OpenClaw) 驱动的智能助手，可以联网搜索、处理任务。",
    "",
    "回复规则：",
    "- 用中文回复，自然亲切",
    "- 群聊回复保持简洁，不要过长",
    "- 私聊可以稍微详细一些",
    "- 如果不确定怎么回答，诚实说明",
    "- 你可以使用 Markdown 格式，但 QQ 不完全支持，尽量用纯文本",
    "",
    "你可以提供的帮助：",
    "- 回答问题、提供信息",
    "- 搜索网络获取最新资讯",
    "- 翻译、总结、分析文本",
    "- 聊天、娱乐、建议",
    "",
    `当前时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`
  ].join("\n");
}

/**
 * Send a QQ message to QClaw and get an AI reply.
 *
 * Session persistence strategy (mirrors NapCatCodexGateway's log-path approach):
 * 1. Each user/group gets a session identified by userId(+groupId).
 * 2. On the first message, recent history is loaded from the JSONL log.
 * 3. Subsequent messages within TTL reuse the in-memory cache.
 * 4. Bot replies are appended to the cache so the model sees the full conversation.
 */
export async function askQClaw(
  userMessage: string,
  userId: number,
  context?: {
    senderName?: string;
    isGroup?: boolean;
    groupId?: number;
  }
): Promise<string> {
  const key = sessionKey(userId, context?.isGroup ? context.groupId : undefined);
  resetHistoryTimer(key);

  // Ensure the in-memory cache is populated (load from log on first use)
  if (!historyCache.has(key)) {
    const logPath = context?.isGroup && context?.groupId
      ? path.join(config.dataDir, "group-messages.jsonl")
      : path.join(config.dataDir, "private-messages.jsonl");
    const fromLog = loadRecentFromLog(logPath, 20, config.botNickname);
    historyCache.set(key, fromLog);
  }

  const history = historyCache.get(key)!;

  const systemPrompt = buildSystemPrompt();

  // Build the contextual message (include sender info)
  let contextualMessage = userMessage;
  if (context?.senderName) {
    contextualMessage = `[来自 ${context.senderName}] ${contextualMessage}`;
  }
  if (context?.isGroup && context?.groupId) {
    contextualMessage = `[群聊 ${context.groupId}] ${contextualMessage}`;
  } else if (!context?.isGroup && context?.senderName) {
    contextualMessage = `[私聊 ${context.senderName}] ${contextualMessage}`;
  }

  // Assemble full message array: system + history + current message
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: contextualMessage }
  ];

  // Trim if too long (keep system + tail of history + current)
  while (messages.length > MAX_HISTORY + 1) {
    // Remove oldest history entry (skip index 0 = system)
    messages.splice(1, 1);
  }

  const reply = await callQClawChatCompletion(messages);

  // Cache this turn for future context
  history.push({ role: "user", content: contextualMessage });
  history.push({ role: "assistant", content: reply });

  // Trim cache
  while (history.length > MAX_HISTORY) {
    history.splice(0, 2); // remove oldest user+assistant pair
  }

  return reply;
}

/**
 * Notify QClaw about a QQ message (for logging/monitoring) and get AI response.
 */
export async function notifyAndAskQClaw(message: string, userId: number, context?: {
  senderName?: string;
  isGroup?: boolean;
  groupId?: number;
}): Promise<string | null> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(() => askQClaw(message, userId, context)) as Promise<string | null>;

  return notificationQueue;
}

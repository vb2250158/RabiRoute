/**
 * RabiRoute → AstrBot Agent Adapter
 *
 * Bridges RabiRoute notifications into AstrBot's LLM pipeline,
 * analogous to how codexApp.ts bridges to Codex.
 *
 * Requires the `rabiroute_agent` AstrBot plugin to be installed
 * (places it in %USERPROFILE%\.astrbot\data\plugins\rabiroute_agent\ on Windows).
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// --------------- types ---------------

type AstrBotAgentState = {
  agentAdapterType: "astrbot";
  monitorThreadId?: string;
  monitorThreadName?: string;
  monitorThreadSource?: string;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
  lastResponsePreview?: string;
};

// --------------- state ---------------

const statePath = path.join(config.dataDir, "astrbot-agent-state.json");

function readState(): AstrBotAgentState {
  if (!fs.existsSync(statePath)) {
    return baseState();
  }
  try {
    return {
      ...baseState(),
      ...JSON.parse(
        fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")
      ) as Partial<AstrBotAgentState>,
    };
  } catch {
    return baseState();
  }
}

function writeState(state: AstrBotAgentState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function baseState(): AstrBotAgentState {
  return {
    agentAdapterType: "astrbot",
  };
}

// --------------- config helpers ---------------

function getAstrBotUrl(): string {
  return process.env.ASTRBOT_URL ?? "http://127.0.0.1:6185";
}

function getAstrBotUsername(): string {
  return process.env.ASTRBOT_USERNAME ?? "";
}

function getAstrBotPassword(): string {
  return process.env.ASTRBOT_PASSWORD ?? "";
}

function getAstrBotSessionId(): string {
  return process.env.ASTRBOT_SESSION_ID ?? "";
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// --------------- auth ---------------

async function login(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const baseUrl = getAstrBotUrl().replace(/\/$/, "");
  const username = getAstrBotUsername();
  const password = getAstrBotPassword();

  if (!password) {
    throw new Error(
      "ASTRBOT_PASSWORD environment variable is not set. " +
        "Set it to your AstrBot dashboard password so RabiRoute can authenticate."
    );
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AstrBot login failed (HTTP ${response.status}): ${text}`);
  }

  const body = (await response.json()) as { status?: string; message?: string; error?: string; data?: { token?: string } | null };
  if (body.status === "error" || body.error) {
    throw new Error(`AstrBot login failed: ${body.message || body.error || "unknown error"}`);
  }
  const token = body?.data?.token;
  if (!token) {
    throw new Error("AstrBot login response missing token");
  }

  // JWT tokens have a 3-part structure; we don't decode, just cache for 55 min
  cachedToken = token;
  tokenExpiresAt = now + 55 * 60 * 1000;

  return token;
}

// --------------- deliver ---------------

let notificationQueue: Promise<void> = Promise.resolve();

export async function notifyAstrbot(message: string): Promise<void> {
  const previous = notificationQueue;
  let resolveNext: () => void;
  notificationQueue = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });

  try {
    await previous;
    await deliverOnce(message);
  } finally {
    resolveNext!();
  }
}

async function deliverOnce(message: string): Promise<void> {
  const state = readState();

  try {
    const token = await login();
    const baseUrl = getAstrBotUrl().replace(/\/$/, "");
    const sessionId = getAstrBotSessionId().trim();
    const reply = sessionId
      ? await deliverToChatUiSession(baseUrl, token, sessionId, message)
      : await deliverToLegacyPlugin(baseUrl, token, message);

    writeState({
      ...state,
      monitorThreadId: sessionId ? `astrbot-chatui:${sessionId}` : "astrbot-plugin:rabiroute_agent",
      monitorThreadName: sessionId ? `AstrBot ChatUI ${sessionId}` : "AstrBot rabiroute_agent",
      monitorThreadSource: baseUrl,
      notificationCount: (state.notificationCount ?? 0) + 1,
      lastNotificationAt: new Date().toISOString(),
      lastResponsePreview: reply.slice(0, 500),
      lastNotificationError: undefined,
      lastNotificationErrorAt: undefined,
    });

    // The response has already been delivered to AstrBot's LLM.
    // AstrBot handles its own output (e.g. QQ send via its own platform adapters).
    console.log(
      `[astrbotAdapter] Delivered message (${message.length} chars), ` +
        `response preview: ${reply.slice(0, 120)}`
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error(`[astrbotAdapter] Notification error: ${messageText}`);

    writeState({
      ...state,
      lastNotificationError: messageText,
      lastNotificationErrorAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function deliverToLegacyPlugin(baseUrl: string, token: string, message: string): Promise<string> {
  const chatUrl = `${baseUrl}/api/plug/rabiroute_agent/chat`;
  const response = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });

  const text = await response.text();
  let body: { response?: string; error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // keep as raw text
  }

  if (!response.ok || body.error) {
    throw new Error(
      body.error || `AstrBot plugin chat failed (HTTP ${response.status}): ${text}`
    );
  }

  return body.response ?? "";
}

async function deliverToChatUiSession(baseUrl: string, token: string, sessionId: string, message: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      message,
      enable_streaming: false,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AstrBot ChatUI send failed (HTTP ${response.status}): ${text}`);
  }

  const plainParts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      const event = JSON.parse(payload) as { type?: string; data?: unknown; chain_type?: string };
      if (event.type === "plain" && typeof event.data === "string") {
        plainParts.push(event.data);
      }
    } catch {
      // ignore non-json SSE lines
    }
  }
  return plainParts.join("").trim();
}

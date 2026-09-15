/**
 * WorkBuddy (Tencent AI office workbench) session gateway credential handling.
 *
 * Every interactive WorkBuddy session process listens on its own loopback HTTP
 * port and authenticates callers in the application layer, because the OS does
 * not distinguish local callers on a TCP socket. Unlike Codex (which is reached
 * over a Windows named pipe whose kernel ACL *is* the credential), WorkBuddy
 * therefore needs an explicit password.
 *
 * The desktop injects `CODEBUDDY_GATEWAY_PASSWORD` into each session process.
 * RabiRoute Manager is a separate process and cannot read that environment, so
 * the credential must be supplied through an explicit local path. This module
 * owns every read of that credential; nothing else in the codebase may reach
 * for it, and nothing here is ever logged.
 *
 * Resolution order (first hit wins, all candidates are loopback-only):
 *   1. `RABI_WORKBUDDY_GATEWAY_PASSWORD` process environment (tests, wrappers).
 *   2. `<state>/data/workbuddy-auth.json` -> `{ "password": "..." }`, a local
 *      ignored file that mirrors `data/dsh-auth.json` (endpoint metadata only).
 *
 * Status: implemented; the file-based path is the supported operator entry
 * until the desktop exposes a pairing handoff. Missing credential is a hard,
 * actionable failure — never a silent fallback and never an unauthenticated
 * retry.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";
import { fileURLToPath } from "node:url";

/** Cached credential plus the moment it must be re-read. */
type CachedCredential = { password: string; expires: number };

const cache = new Map<string, CachedCredential>();
const pending = new Map<string, Promise<string>>();

/**
 * Credentials are re-read periodically so an operator rotating the password
 * does not have to restart the Manager. A 401 always invalidates immediately.
 */
const CREDENTIAL_TTL_MS = 5 * 60 * 1000;

export class WorkbuddyCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbuddyCredentialError";
  }
}

/**
 * Only loopback endpoints may ever receive a local gateway credential. A
 * configured tunnel URL must not turn this into a remote credential leak.
 */
export function assertWorkbuddyLoopback(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WorkbuddyCredentialError("WorkBuddy 会话网关地址无效。");
  }
  if (url.protocol !== "http:" || url.username || url.password) {
    throw new WorkbuddyCredentialError("WorkBuddy 会话网关必须使用不带凭据的 http 回环地址。");
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new WorkbuddyCredentialError("WorkBuddy 本地凭据只能发送到回环地址，已停止。");
  }
  return url.origin;
}

function defaultCredentialFilePath(): string {
  const root = resolveRuntimeLayout(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  ).stateRoot;
  return path.join(root, "data", "workbuddy-auth.json");
}

/** The absolute path of the local credential file, for diagnostics only. */
export function workbuddyCredentialFilePath(): string {
  const configured = process.env.RABI_WORKBUDDY_AUTH_FILE?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new WorkbuddyCredentialError("RABI_WORKBUDDY_AUTH_FILE 必须是绝对路径。");
  }
  return configured || defaultCredentialFilePath();
}

function plausiblePassword(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  // WorkBuddy gateway passwords are opaque URL-safe tokens; reject anything
  // that could only be a placeholder so a half-filled file fails closed.
  if (text.length < 16 || text.length > 512) return "";
  if (/^(changeme|placeholder|password|xxx+|<.*>)$/i.test(text)) return "";
  return text;
}

async function readCredentialFile(filePath: string): Promise<string> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !process.env.RABI_WORKBUDDY_AUTH_FILE?.trim()) return "";
    throw new WorkbuddyCredentialError("WorkBuddy 本地凭据文件无法读取。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkbuddyCredentialError("WorkBuddy 本地凭据文件不是合法 JSON。");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WorkbuddyCredentialError("WorkBuddy 本地凭据文件格式不正确。");
  }
  const record = parsed as Record<string, unknown>;
  if (record.password !== undefined) return plausiblePassword(record.password);
  // Tolerate the endpoint-keyed shape used by dsh-auth.json for consistency.
  const endpoints = record.endpoints;
  if (Array.isArray(endpoints)) {
    const found = endpoints
      .map(entry => (entry && typeof entry === "object" ? plausiblePassword((entry as Record<string, unknown>).password) : ""))
      .find(Boolean);
    return found ?? "";
  }
  return "";
}

/**
 * Resolve the gateway password. Never logs, never returns a partial value, and
 * never falls back to an unauthenticated request.
 */
export async function workbuddyGatewayPassword(options: { force?: boolean } = {}): Promise<string> {
  const envPassword = plausiblePassword(process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD);
  if (envPassword) return envPassword;

  const filePath = workbuddyCredentialFilePath();
  const cached = cache.get(filePath);
  if (!options.force && cached && cached.expires > Date.now()) return cached.password;

  let work = pending.get(filePath);
  if (!work || options.force) {
    work = (async () => {
      const password = await readCredentialFile(filePath);
      if (!password) {
        throw new WorkbuddyCredentialError(
          `WorkBuddy 会话网关需要本地凭据：请在 ${filePath} 写入 {"password":"<网关密码>"}（该文件已被 git 忽略）。`
        );
      }
      cache.set(filePath, { password, expires: Date.now() + CREDENTIAL_TTL_MS });
      return password;
    })();
    pending.set(filePath, work);
  }
  try {
    return await work;
  } finally {
    if (pending.get(filePath) === work && !options.force) pending.delete(filePath);
  }
}

/** Drop a cached credential; called after a 401 so the next call re-reads. */
export function invalidateWorkbuddyGatewayPassword(): void {
  cache.clear();
}

/** Diagnostics only: never returns the password itself. */
export async function workbuddyCredentialStatus(): Promise<{
  configured: boolean;
  source: "environment" | "file" | "none";
  filePath: string;
}> {
  const filePath = workbuddyCredentialFilePath();
  if (plausiblePassword(process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD)) {
    return { configured: true, source: "environment", filePath };
  }
  try {
    const password = await readCredentialFile(filePath);
    return { configured: Boolean(password), source: password ? "file" : "none", filePath };
  } catch {
    return { configured: false, source: "none", filePath };
  }
}

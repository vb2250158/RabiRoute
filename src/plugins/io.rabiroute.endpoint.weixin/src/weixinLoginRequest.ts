import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { atomicWriteFileSync, withFileLockSync } from "@rabiroute/host-api/shared/filePersistence";
import { createLocalSecretProtector } from "@rabiroute/host-api/shared/localSecretProtection";

const REQUEST_FILE = "weixin-login-request.json";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const PIN_FILE = "weixin-login-pin.protected";
export const WEIXIN_LOGOUT_REQUEST_FILE = "weixin-logout-request";
export type WeixinBindingMode = "owner" | "other";

export function weixinLoginRequestPath(dataDir: string): string {
  return path.join(dataDir, REQUEST_FILE);
}

export function requestWeixinLogin(dataDir: string, now = new Date(), mode: WeixinBindingMode = "owner"): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = weixinLoginRequestPath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({
      schemaVersion: 1,
      requestedAt: now.toISOString(),
      mode
    }, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "weixin",
      event: "weixin_login_request_write_failed",
      owner: "weixin-login-request",
      action: "request-login",
      target: { type: "login-request", id: "weixin" },
      dataSource: { kind: "file", id: REQUEST_FILE },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "weixin",
    event: "weixin_login_requested",
    owner: "weixin-login-request",
    action: "request-login",
    target: { type: "login-request", id: "weixin" },
    dataSource: { kind: "file", id: REQUEST_FILE },
    outcome: "committed",
    after: { revision: now.toISOString() }
  });
}

export function hasActiveWeixinLoginRequest(dataDir: string, now = new Date()): boolean {
  return Boolean(readWeixinLoginMode(dataDir, now));
}

export function readWeixinLoginMode(dataDir: string, now = new Date()): WeixinBindingMode | undefined {
  const filePath = weixinLoginRequestPath(dataDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { requestedAt?: unknown; mode?: unknown };
    const requestedAt = Date.parse(String(parsed.requestedAt || ""));
    const age = now.getTime() - requestedAt;
    if (Number.isFinite(age) && age >= 0 && age <= REQUEST_TTL_MS) return parsed.mode === "other" ? "other" : "owner";
  } catch {
    return undefined;
  }
}

export function submitWeixinPin(dataDir: string, attemptId: string, pin: string): void {
  const file = path.join(dataDir, PIN_FILE);
  const protectedPin = createLocalSecretProtector(dataDir).protect(JSON.stringify({ attemptId, pin }));
  withFileLockSync(file + ".lock", () => atomicWriteFileSync(file, protectedPin, { mode: 0o600 }));
}

function consumeWeixinPin(dataDir: string, attemptId: string): string | undefined {
  const file = path.join(dataDir, PIN_FILE);
  if (!fs.existsSync(file)) return;
  return withFileLockSync(file + ".lock", () => {
    if (!fs.existsSync(file)) return;
    const ciphertext = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
    const payload = JSON.parse(createLocalSecretProtector(dataDir).unprotect(ciphertext)) as { attemptId: string; pin: string };
    return payload.attemptId === attemptId ? payload.pin : undefined;
  });
}

export function waitForWeixinPin(
  dataDir: string, attemptId: string, timeoutMs: number, signal: AbortSignal
): Promise<string | undefined> {
  if (signal.aborted || timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(dataDir, { persistent: false }, (_, filename) => {
      if (!filename || filename === PIN_FILE || filename === WEIXIN_LOGOUT_REQUEST_FILE) read();
    });
    const deadline = setTimeout(() => finish(), timeoutMs);
    const aborted = () => finish();
    function cleanup() {
      watcher.close();
      clearTimeout(deadline);
      signal.removeEventListener("abort", aborted);
    }
    function finish(pin?: string) { cleanup(); resolve(pin); }
    function read() {
      try {
        if (signal.aborted || hasWeixinLogoutRequest(dataDir)) { finish(); return; }
        const pin = consumeWeixinPin(dataDir, attemptId);
        if (pin) finish(pin);
      } catch (error) { cleanup(); reject(error); }
    }
    watcher.once("error", error => { cleanup(); reject(error); });
    signal.addEventListener("abort", aborted, { once: true });
    read();
  });
}

export function requestWeixinLogout(dataDir: string): void {
  atomicWriteFileSync(path.join(dataDir, WEIXIN_LOGOUT_REQUEST_FILE), "", { mode: 0o600 });
}

export function hasWeixinLogoutRequest(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, WEIXIN_LOGOUT_REQUEST_FILE));
}

export function completeWeixinLogout(dataDir: string): void {
  fs.rmSync(path.join(dataDir, WEIXIN_LOGOUT_REQUEST_FILE), { force: true });
}

export function clearWeixinLoginRequest(dataDir: string): void {
  try {
    fs.unlinkSync(weixinLoginRequestPath(dataDir));
    recordDataMutationAudit({
      group: "weixin",
      event: "weixin_login_request_cleared",
      owner: "weixin-login-request",
      action: "clear-login-request",
      target: { type: "login-request", id: "weixin" },
      dataSource: { kind: "file", id: REQUEST_FILE },
      outcome: "committed"
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code !== "ENOENT") {
      recordDataMutationAudit({
        level: "error",
        group: "weixin",
        event: "weixin_login_request_clear_failed",
        owner: "weixin-login-request",
        action: "clear-login-request",
        target: { type: "login-request", id: "weixin" },
        dataSource: { kind: "file", id: REQUEST_FILE },
        outcome: "failed",
        error
      });
      throw error;
    }
  }
}

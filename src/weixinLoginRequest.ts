import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

const REQUEST_FILE = "weixin-login-request.json";
const REQUEST_TTL_MS = 10 * 60 * 1000;

export function weixinLoginRequestPath(dataDir: string): string {
  return path.join(dataDir, REQUEST_FILE);
}

export function requestWeixinLogin(dataDir: string, now = new Date()): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = weixinLoginRequestPath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({
      schemaVersion: 1,
      requestedAt: now.toISOString()
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
  const filePath = weixinLoginRequestPath(dataDir);
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { requestedAt?: unknown };
    const requestedAt = Date.parse(String(parsed.requestedAt || ""));
    return Number.isFinite(requestedAt)
      && now.getTime() - requestedAt >= 0
      && now.getTime() - requestedAt <= REQUEST_TTL_MS;
  } catch {
    return false;
  }
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

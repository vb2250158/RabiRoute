import fs from "node:fs";
import path from "node:path";

const REQUEST_FILE = "weixin-login-request.json";
const REQUEST_TTL_MS = 10 * 60 * 1000;

export function weixinLoginRequestPath(dataDir: string): string {
  return path.join(dataDir, REQUEST_FILE);
}

export function requestWeixinLogin(dataDir: string, now = new Date()): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = weixinLoginRequestPath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    schemaVersion: 1,
    requestedAt: now.toISOString()
  }, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
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
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code !== "ENOENT") throw error;
  }
}

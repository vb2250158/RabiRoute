import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";

const cookies = new Map<string, { value: string; expires: number }>();
const pending = new Map<string, Promise<string>>();

function originOf(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('DSH authentication endpoint is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('DSH authentication requires a clean HTTP(S) origin.');
  return url.origin;
}

/** Configuration contains only endpoint and local log paths, never credentials. */
async function launchLogFor(origin: string): Promise<string | undefined> {
  const root = resolveRuntimeLayout(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).stateRoot;
  const configPath = process.env.RABI_DSH_AUTH_FILE?.trim() || path.join(root, 'data', 'dsh-auth.json');
  if (!path.isAbsolute(configPath)) throw new Error('RABI_DSH_AUTH_FILE must be absolute.');
  let text: string;
  try { text = await fs.readFile(configPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !process.env.RABI_DSH_AUTH_FILE?.trim()) return undefined; throw new Error('DSH authentication configuration is unreadable.'); }
  let config: { endpoints?: Array<{ baseUrl: string; launchLogPath: string }> };
  try { config = JSON.parse(text); } catch { throw new Error('DSH authentication configuration is invalid JSON.'); }
  if (!config || !Array.isArray(config.endpoints)) throw new Error('DSH authentication configuration requires endpoints.');
  if (config.endpoints.some(row => !row || typeof row.baseUrl !== 'string')) throw new Error('DSH authentication endpoint configuration is invalid.');
  const matches = config.endpoints.filter(row => originOf(row.baseUrl) === origin);
  if (matches.length > 1) throw new Error('DSH authentication has duplicate endpoint configuration.');
  if (!matches.length) throw new Error('DSH authentication configuration has no matching endpoint.');
  const logPath = matches[0].launchLogPath;
  if (typeof logPath !== 'string' || !path.isAbsolute(logPath)) throw new Error('DSH launchLogPath must be absolute.');
  // A local launch credential must never be sent to a remote endpoint.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('DSH local launch-log authentication requires a loopback endpoint.');
  return logPath;
}

async function exchange(origin: string, logPath: string): Promise<string> {
  let tail: string;
  try {
    const file = await fs.open(logPath, 'r');
    try {
      const stat = await file.stat();
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, stat.size - length);
      tail = buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch { throw new Error('DSH launch log is unreadable; configure the current owner launch log.'); }
  let launch: URL | undefined;
  for (const match of tail.matchAll(/dsh web: (https?:\/\/[^\s<>"']+)/g)) {
    try {
      const candidate = new URL(match[1]);
      if (candidate.origin === origin && candidate.pathname === '/' && !candidate.username && !candidate.password &&
          !candidate.hash && candidate.searchParams.size === 1 && candidate.searchParams.getAll('token').length === 1 &&
          /^[A-Za-z0-9_-]+$/.test(candidate.searchParams.get('token') || '')) launch = candidate;
    } catch { /* Ignore unrelated or malformed log entries without echoing them. */ }
  }
  if (!launch) throw new Error('DSH current launch URL is absent from the configured log.');
  let response: Response;
  try { response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('DSH authentication exchange failed; no RPC was sent.'); }
  if (response.status !== 303 || response.headers.get('location') !== '/') throw new Error('DSH authentication exchange rejected; reopen the current owner launch URL.');
  const values = response.headers.getSetCookie();
  const valid = values.filter(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+;/.test(value) && /;\s*HttpOnly(?:;|$)/i.test(value) && /;\s*Path=\/(?:;|$)/i.test(value));
  if (valid.length !== 1) throw new Error('DSH authentication exchange did not issue one supported session cookie.');
  const now = Date.now();
  let expires = now + 5 * 60 * 1000;
  const maxAge = /;\s*Max-Age=([^;]*)/i.exec(valid[0]);
  const expiry = /;\s*Expires=([^;]*)/i.exec(valid[0]);
  if (maxAge) {
    const seconds = Number(maxAge[1]);
    if (!/^\d+$/.test(maxAge[1]) || !Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('DSH authentication issued an invalid or expired cookie.');
    expires = Math.min(expires, now + seconds * 1000);
  } else if (expiry) {
    const timestamp = Date.parse(expiry[1]);
    if (!Number.isFinite(timestamp) || timestamp <= now) throw new Error('DSH authentication issued an invalid or expired cookie.');
    expires = Math.min(expires, timestamp);
  }
  const value = valid[0].split(';', 1)[0];
  cookies.set(`${origin}\n${logPath}`, { value, expires });
  return value;
}

/** Authenticate before dispatch. Never retry an RPC, including after a 401. */
export async function dshAuthenticatedFetch(baseUrl: string, method: string, body: string): Promise<Response> {
  const origin = originOf(baseUrl);
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[./][A-Za-z][A-Za-z0-9]*)+$/.test(method)) throw new Error('DSH RPC method is invalid.');
  const logPath = await launchLogFor(origin);
  let cookie: string | undefined;
  if (logPath) {
    const cacheKey = `${origin}\n${logPath}`;
    const cached = cookies.get(cacheKey);
    if (cached && cached.expires > Date.now()) cookie = cached.value;
    else {
      let work = pending.get(cacheKey);
      if (!work) {
        work = exchange(origin, logPath);
        pending.set(cacheKey, work);
      }
      try { cookie = await work; } finally { if (pending.get(cacheKey) === work) pending.delete(cacheKey); }
    }
  }
  let response: Response;
  try {
    response = await fetch(`${origin}/api/${method}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body
    });
  } catch { throw new Error('DSH RPC transport failed; result may be unknown, check the original receipt before retrying.'); }
  if (response.status === 401) {
    if (logPath && cookies.get(`${origin}\n${logPath}`)?.value === cookie) cookies.delete(`${origin}\n${logPath}`);
    throw new Error('DSH authentication required or expired. Configure data/dsh-auth.json with the current endpoint and launchLogPath; this RPC was not replayed.');
  }
  return response;
}

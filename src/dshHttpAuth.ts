import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";
import { DshConnectionStore, DshConnectionError, dshLocalOrigin, type DshSessionCredential, dshConnectionFile } from "./dshConnectionStore.js";
import { createHash, randomUUID } from "node:crypto";

const cookies = new Map<string, { value: string; expires: number }>();
const pending = new Map<string, Promise<string>>();
let connectionStore: DshConnectionStore | undefined;
function currentConnectionStore(): DshConnectionStore {
  const file = dshConnectionFile();
  if (connectionStore?.filePath !== file) connectionStore = new DshConnectionStore(file);
  return connectionStore;
}

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

async function exchange(origin: string, logPath: string, strict = false, signal?: AbortSignal): Promise<DshSessionCredential> {
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
  const credential = await exchangeLaunchUrl(launch, strict, signal);
  cookies.set(`${origin}\n${logPath}`, { value: credential.cookie, expires: Math.min(credential.expiresAt, Date.now() + 5 * 60 * 1000) });
  return credential;
}

async function exchangeLaunchUrl(launch: URL, strict = false, signal?: AbortSignal): Promise<DshSessionCredential> {
  let response: Response;
  try { response = await fetch(launch, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch { throw new Error('DSH authentication exchange failed; no RPC was sent.'); }
  if (response.status !== 303 || response.headers.get('location') !== '/') throw new Error('DSH authentication exchange rejected; reopen the current owner launch URL.');
  const values = response.headers.getSetCookie();
  const valid = values.filter(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+;/.test(value) && /;\s*HttpOnly(?:;|$)/i.test(value) && /;\s*Path=\/(?:;|$)/i.test(value));
  if (valid.length !== 1) throw new Error('DSH authentication exchange did not issue one supported session cookie.');
  const now = Date.now();
  const expectedName = `dsh-auth-${createHash('sha256').update(launch.host).digest('base64url')}`;
  if (strict && (!valid[0].startsWith(`${expectedName}=`) || /;\s*Domain=/i.test(valid[0])
    || !/;\s*SameSite=Strict(?:;|$)/i.test(valid[0]))) throw new DshConnectionError('DSH issued an unsupported authentication cookie.');
  let expires = now + (strict ? 366 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000);
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
  if (strict && !maxAge && !expiry) throw new DshConnectionError('DSH authentication cookie has no expiry.');
  return { cookie: valid[0].split(';', 1)[0], expiresAt: expires };
}

/** Explicit local-user authorization. The launch URL is never persisted or returned. */
export async function connectDshOwner(launchUrl: unknown, expectedRevision: number, store = new DshConnectionStore(), signal?: AbortSignal) {
  if (typeof launchUrl !== 'string' || launchUrl.length > 8192) throw new DshConnectionError('Provide the current DSH login link.');
  let launch: URL;
  try { launch = new URL(launchUrl.trim()); } catch { throw new DshConnectionError('DSH login link is invalid.'); }
  if (launch.username || launch.password || launch.hash || launch.pathname !== '/' || launch.searchParams.size !== 1
    || launch.searchParams.getAll('token').length !== 1 || !/^[A-Za-z0-9_-]+$/.test(launch.searchParams.get('token') || '')) {
    throw new DshConnectionError('Use the current DSH root login link with one token.');
  }
  const origin = dshLocalOrigin(launch.origin);
  if (store.readMetadata().revision !== expectedRevision) throw new DshConnectionError('DSH connections changed; refresh before retrying.', 409);
  const credential = await exchangeLaunchUrl(launch, true, signal);
  await verifyDshCredential(origin, credential.cookie, signal);
  signal?.throwIfAborted();
  store.connect(origin, credential, expectedRevision);
  return { baseUrl: origin, state: 'connected', expiresAt: credential.expiresAt, revision: store.readMetadata().revision };
}

/** Explicit migration only. Disconnected/expired protected records never fall back to logs. */
export async function migrateDshOwner(baseUrl: string, expectedRevision: number, store = new DshConnectionStore(), signal?: AbortSignal) {
  const origin = dshLocalOrigin(baseUrl);
  if (store.readMetadata().revision !== expectedRevision) throw new DshConnectionError('DSH connections changed; refresh before retrying.', 409);
  const saved = store.resolve(origin);
  if (saved && saved.state !== 'connected') throw new DshConnectionError('Reconnect using the current DSH login link.', 401);
  let credential: DshSessionCredential;
  if (saved?.state === 'connected') credential = saved;
  else {
    const logPath = await launchLogFor(origin);
    if (!logPath) throw new DshConnectionError('Provide the current DSH login link to connect.', 401);
    credential = await exchange(origin, logPath, true, signal);
  }
  try { await verifyDshCredential(origin, credential.cookie, signal); }
  catch (error) {
    if (saved?.state === 'connected' && error instanceof DshConnectionError && error.status === 401) store.invalidate(origin, credential.cookie);
    throw error;
  }
  signal?.throwIfAborted();
  store.connect(origin, credential, expectedRevision);
  return { baseUrl: origin, state: 'connected', expiresAt: credential.expiresAt, revision: store.readMetadata().revision };
}

async function verifyDshCredential(origin: string, cookie: string, signal?: AbortSignal): Promise<void> {
  const rpcId = randomUUID();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/session/list`, { method: 'POST', redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }) });
  } catch { throw new DshConnectionError('DSH connection verification failed; no task message was sent.', 502); }
  if (response.status === 401) throw new DshConnectionError('DSH rejected connection verification; reconnect using the current login link.', 401);
  if (!response.ok) throw new DshConnectionError('DSH session API verification failed; saved authorization was not changed.', 502);
  const reader = response.body?.getReader();
  if (!reader) throw new DshConnectionError('DSH connection verification returned no response.', 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new DshConnectionError('DSH connection verification response is too large.', 502);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DshConnectionError) throw error;
    throw new DshConnectionError('DSH connection verification was interrupted; no authentication was saved.', 502);
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let value: { rpcId?: string; result?: { ok?: boolean } };
  try { value = JSON.parse(text); } catch { throw new DshConnectionError('DSH connection verification returned an invalid response.', 502); }
  if (value.rpcId !== rpcId || value.result?.ok !== true) throw new DshConnectionError('DSH session API is not ready; no authentication was saved.', 502);
}

/** Authenticate before dispatch. Never retry an RPC, including after a 401. */
export async function dshAuthenticatedFetch(baseUrl: string, method: string, body: string): Promise<Response> {
  const origin = originOf(baseUrl);
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[./][A-Za-z][A-Za-z0-9]*)+$/.test(method)) throw new Error('DSH RPC method is invalid.');
  const saved = currentConnectionStore().resolve(origin);
  if (saved && saved.state !== 'connected') throw new DshConnectionError('DSH authorization is expired or disconnected; reconnect in WebGUI.', 401);
  const logPath = saved ? undefined : await launchLogFor(origin);
  let cookie: string | undefined = saved?.cookie;
  if (logPath) {
    const cacheKey = `${origin}\n${logPath}`;
    const cached = cookies.get(cacheKey);
    if (cached && cached.expires > Date.now()) cookie = cached.value;
    else {
      let work = pending.get(cacheKey);
      if (!work) {
        work = exchange(origin, logPath).then(credential => credential.cookie);
        pending.set(cacheKey, work);
      }
      try { cookie = await work; } finally { if (pending.get(cacheKey) === work) pending.delete(cacheKey); }
    }
  }
  // An explicit disconnect/reconnect may commit while the legacy exchange awaits IO.
  // Check again immediately before dispatch; never send with the previous authorization.
  const current = currentConnectionStore().resolve(origin);
  if (current && (current.state !== 'connected' || !saved || current.cookie !== saved.cookie)) {
    throw new DshConnectionError('DSH authorization changed; refresh the connection before sending.', 409);
  }
  if (current?.state === 'connected') cookie = current.cookie;
  let response: Response;
  try {
    response = await fetch(`${origin}/api/${method}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body
    });
  } catch { throw new Error('DSH RPC transport failed; result may be unknown, check the original receipt before retrying.'); }
  if (response.status === 401) {
    if (current?.state === 'connected' && cookie) currentConnectionStore().invalidate(origin, cookie);
    if (logPath && cookies.get(`${origin}\n${logPath}`)?.value === cookie) cookies.delete(`${origin}\n${logPath}`);
    throw new Error('DSH authentication required or expired. Reconnect DSH in the local RabiRoute WebGUI; this RPC was not replayed.');
  }
  return response;
}

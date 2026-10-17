import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_GROK_BOT_BACKEND_URL = "https://api2.cursor.sh/";
const SESSION_PREFIX = "grokBot:";
const SERVICE_PATH = "aiserver.v1.GrokBotService/";

export class GrokBotError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  readonly httpStatus?: number;
  readonly method?: string;
  readonly retryable: boolean;
  constructor(code: string, options: { uncertain?: boolean; httpStatus?: number; method?: string; retryable?: boolean } = {}) {
    super(options.method ? `${code} (${options.method})` : code);
    this.name = "GrokBotError";
    this.code = code;
    this.uncertain = options.uncertain === true;
    this.httpStatus = options.httpStatus;
    this.method = options.method;
    this.retryable = options.retryable === true;
  }
}

export type GrokBotCredentials = {
  signedIn: true;
  accountScope: string;
  accessToken: string;
  selectedTeamId?: string;
  machineId?: string;
  appVersion?: string;
};
type ProtectedValue = { format: "aes-gcm" | "dpapi"; data: string };
export type GrokBotProfileSnapshot = {
  version: number;
  signedIn: boolean;
  accountScope?: string;
  appVersion?: string;
  accessToken?: ProtectedValue;
  selectedTeamId?: ProtectedValue | null;
  machineId?: ProtectedValue | null;
  encryptionKey?: string;
  errorCode?: string;
};
export type GrokBotClientOptions = {
  backendUrl?: string;
  profilePath?: string;
  profileScriptPath?: string;
  powershellPath?: string;
  timeoutMs?: number;
  request?: typeof fetch;
  readProfile?: () => Promise<GrokBotCredentials>;
  runProfileHelper?: (context: { profilePath: string; scriptPath: string; timeoutMs: number }) => Promise<GrokBotProfileSnapshot>;
};
export type GrokBotNativeBot = {
  agentId: string;
  name: string;
  kind?: string | number;
  memberAgentIds?: string[];
  harness?: string;
  viewerSessionId?: string;
  updatedAtMs?: string;
};
export type GrokBotNativeSession = {
  agentId: string;
  sessionId: string;
  defaultMain?: true;
  kind?: string | number;
  createdAtMs?: string;
  updatedAtMs?: string;
  lastActivityAtMs?: string;
};
export type GrokBotRoster = { bots: GrokBotNativeBot[]; truncated: boolean };
export type GrokBotTranscriptPage = {
  entries: unknown[];
  generation: number;
  cloudAgentPeerIds: string[];
  cloudAgentPeerIdsKnown: boolean;
};
export type GrokBotDeliveryOptions = { deliveryType: "private" | "group"; sendMode: "direct" | "identity"; senderAgentId?: string };
export type GrokBotSendInput = { agentId: string; sessionId: string; defaultMain?: true; messageId: string; text: string;
  fromAgentId?: string; replyToId?: string; deliveryType?: "private" | "group" };
export type GrokBotSendStatus = {
  status: "accepted" | "rejected" | "pending" | "not-found" | "unknown-durability";
  echoEntryId?: string;
  rejectionCode?: string;
  acceptedAtMs?: string;
};
export type GrokBotSendReceipt = {
  accepted: true;
  agentId: string;
  sessionId: string;
  messageId: string;
  duplicate: boolean;
  recovered: boolean;
  echoEntryId?: string;
  targetAgentId?: string;
  targetName?: string;
  workflowId?: string;
};

export function isGrokBotRoom(bot: GrokBotNativeBot): boolean {
  return ["2", "ROOM", "GROK_BOT_AGENT_KIND_ROOM"].includes(String(bot.kind));
}
function isGrokBotAgent(bot: GrokBotNativeBot): boolean {
  return ["1", "AGENT", "GROK_BOT_AGENT_KIND_AGENT"].includes(String(bot.kind));
}
export function verifyGrokBotRoomMember(roster: GrokBotRoster, agentId: string, room: GrokBotNativeBot): void {
  const sender = roster.bots.find(bot => bot.agentId === agentId);
  if (!sender || !isGrokBotAgent(sender)) throw new GrokBotError("GROK_BOT_SENDER_NOT_FOUND");
  if (!room.memberAgentIds?.includes(agentId)) throw new GrokBotError("GROK_BOT_SENDER_NOT_MEMBER");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function opaque(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GrokBotError("GROK_BOT_SESSION_ID_INVALID");
  }
  return value;
}
function int64(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}
function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value < 1_000 || value > 60_000)) throw new GrokBotError("GROK_BOT_TIMEOUT_INVALID");
  return Math.floor(value ?? fallback);
}
function nativeSessionId(value: string, defaultMain?: true): string {
  if (defaultMain === true && value === "") return "";
  if (defaultMain === true) throw new GrokBotError("GROK_BOT_SESSION_ID_INVALID");
  return opaque(value);
}
export function encodeGrokBotSessionId(agentId: string, sessionId: string, options: { defaultMain?: true } = {}): string {
  const nativeId = nativeSessionId(sessionId, options.defaultMain);
  return SESSION_PREFIX + Buffer.from(JSON.stringify([opaque(agentId), options.defaultMain ? { defaultMain: true } : nativeId]), "utf8").toString("base64url");
}
export function decodeGrokBotSessionId(value: string): { agentId: string; sessionId: string; defaultMain?: true } {
  try {
    if (!value.startsWith(SESSION_PREFIX) || value.length > 8192) throw new Error();
    const parts: unknown = JSON.parse(Buffer.from(value.slice(SESSION_PREFIX.length), "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== 2) throw new Error();
    const agentId = opaque(parts[0]);
    const isDefault = parts[1] && typeof parts[1] === "object" && JSON.stringify(parts[1]) === JSON.stringify({ defaultMain: true });
    const sessionId = isDefault ? "" : opaque(parts[1]);
    const bound = isDefault ? { agentId, sessionId, defaultMain: true as const } : { agentId, sessionId };
    if (encodeGrokBotSessionId(agentId, sessionId, bound) !== value) throw new Error();
    return bound;
  } catch {
    throw new GrokBotError("GROK_BOT_SESSION_ID_INVALID");
  }
}
/** One deterministic UUID for the same transport delivery and canonical target. */
export function grokBotMessageId(deliveryId: string, canonicalSessionId: string): string {
  opaque(deliveryId);
  decodeGrokBotSessionId(canonicalSessionId);
  const bytes = createHash("sha256").update(JSON.stringify(["grokBot-native-delivery-v1", canonicalSessionId, deliveryId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export function normalizeGrokBotBackendUrl(value = DEFAULT_GROK_BOT_BACKEND_URL): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    throw new GrokBotError("GROK_BOT_BACKEND_URL_INVALID");
  }
}
export function grokBotProfilePath(value?: string): string {
  return path.resolve(value || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "Grok Bot"));
}
/** Script overrides are trusted in-process configuration, never scan request fields. */
export function grokBotProfileScriptPath(options: Pick<GrokBotClientOptions, "profileScriptPath"> = {}): string {
  const packageRoot = process.env.RABIROUTE_PACKAGE_ROOT?.trim();
  const candidates = options.profileScriptPath ? [path.resolve(options.profileScriptPath)] : [
    ...(packageRoot ? [path.join(packageRoot, "dist", "scripts", "grok-bot-native-profile.ps1"), path.join(packageRoot, "scripts", "grok-bot-native-profile.ps1")] : []),
    fileURLToPath(new URL("../scripts/grok-bot-native-profile.ps1", import.meta.url)),
    fileURLToPath(new URL("../../scripts/grok-bot-native-profile.ps1", import.meta.url))
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); }
    catch { /* Check the next trusted resource location. */ }
  }
  throw new GrokBotError("GROK_BOT_PROFILE_HELPER_UNAVAILABLE");
}
function decryptProfileValue(value: ProtectedValue | null | undefined, key?: Buffer): string | undefined {
  if (!value) return undefined;
  const encrypted = Buffer.from(value.data, "base64");
  if (value.format === "dpapi") return encrypted.toString("utf8");
  if (value.format !== "aes-gcm" || !key || key.length !== 32 || encrypted.length < 31 || encrypted.subarray(0, 3).toString("ascii") !== "v10") {
    throw new GrokBotError("GROK_BOT_CREDENTIAL_UNREADABLE");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(3, 15));
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]).toString("utf8");
}
/** Decrypted credentials stay in memory; errors never include protected input. */
export function decodeGrokBotProfileSnapshot(snapshot: GrokBotProfileSnapshot, nowMs = Date.now()): GrokBotCredentials {
  if (snapshot.version !== 1 || !snapshot.signedIn || !snapshot.accountScope || !snapshot.accessToken) {
    throw new GrokBotError(snapshot.errorCode && /^GROK_BOT_[A-Z_]+$/.test(snapshot.errorCode) ? snapshot.errorCode : "GROK_BOT_NOT_SIGNED_IN");
  }
  const key = snapshot.encryptionKey ? Buffer.from(snapshot.encryptionKey, "base64") : undefined;
  try {
    const accessToken = decryptProfileValue(snapshot.accessToken, key);
    if (!accessToken) throw new GrokBotError("GROK_BOT_TOKEN_MISSING");
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(Buffer.from(accessToken.split(".")[1] || "", "base64url").toString("utf8"))); }
    catch { throw new GrokBotError("GROK_BOT_TOKEN_INVALID"); }
    if (typeof payload.sub !== "string" || !payload.sub || createHash("sha256").update(payload.sub).digest("hex") !== snapshot.accountScope) {
      throw new GrokBotError("GROK_BOT_ACCOUNT_MISMATCH");
    }
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1000 <= nowMs) throw new GrokBotError("GROK_BOT_TOKEN_EXPIRED");
    const selectedTeamId = decryptProfileValue(snapshot.selectedTeamId, key);
    if (selectedTeamId && !/^[1-9]\d*$/.test(selectedTeamId)) throw new GrokBotError("GROK_BOT_TEAM_INVALID");
    return { signedIn: true, accountScope: snapshot.accountScope, accessToken, selectedTeamId,
      machineId: decryptProfileValue(snapshot.machineId, key), appVersion: snapshot.appVersion };
  } catch (error) {
    if (error instanceof GrokBotError) throw error;
    throw new GrokBotError("GROK_BOT_CREDENTIAL_UNREADABLE");
  } finally { key?.fill(0); }
}
type NativeProfileOptions = Pick<GrokBotClientOptions, "profilePath" | "profileScriptPath" | "powershellPath" | "timeoutMs" | "runProfileHelper">;
const profileCredentials = new Map<string, { fingerprint: string; expiresAt: number; credentials: GrokBotCredentials }>();
const profileReads = new Map<string, { fingerprint: string; promise: Promise<GrokBotCredentials> }>();
const helperIdentities = new WeakMap<NonNullable<GrokBotClientOptions["runProfileHelper"]>, number>();
let nextHelperIdentity = 0;
async function protectedProfileFingerprint(profilePath: string): Promise<string> {
  const buffers: Buffer[] = [];
  try {
    const names = ["desktop-status.json", "sand-secrets.json", "Local State"];
    const hash = createHash("sha256");
    for (const name of names) {
      const file = path.join(profilePath, name);
      if ((await fsAsync.stat(file)).size > 4 * 1024 * 1024) throw new Error();
      const bytes = await fsAsync.readFile(file);
      buffers.push(bytes);
      if (name === "desktop-status.json") {
        const status = JSON.parse(bytes.toString("utf8"));
        if (!Number.isSafeInteger(status.pid) || status.pid <= 0) throw new GrokBotError("GROK_BOT_NOT_RUNNING");
        try { process.kill(status.pid, 0); }
        catch { throw new GrokBotError("GROK_BOT_NOT_RUNNING"); }
      }
      hash.update(name); hash.update(bytes);
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof GrokBotError) throw error;
    throw new GrokBotError((error as NodeJS.ErrnoException).code === "ENOENT" ? "GROK_BOT_PROFILE_MISSING" : "GROK_BOT_PROFILE_UNREADABLE");
  } finally { for (const buffer of buffers) buffer.fill(0); }
}
async function runNativeProfileHelper(options: NativeProfileOptions, profilePath: string, script: string, timeoutMs: number): Promise<GrokBotProfileSnapshot> {
  if (options.runProfileHelper) {
    try { return await options.runProfileHelper({ profilePath, scriptPath: script, timeoutMs }); }
    catch (error) { if (error instanceof GrokBotError) throw error; throw new GrokBotError("GROK_BOT_PROFILE_UNREADABLE"); }
  }
  let output: string;
  try {
    const result = await execFileAsync(options.powershellPath || "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-ProfilePath", profilePath, "-CredentialForClient"], { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 });
    output = result.stdout;
  } catch (error) {
    // execFile errors include stdout/stderr; extract only our closed diagnostic code.
    const stdout = typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : "";
    const code = stdout.match(/"errorCode"\s*:\s*"(GROK_BOT_[A-Z_]+)"/)?.[1];
    if (!code && (error as { killed?: boolean; code?: string })?.killed && (error as { code?: string }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GrokBotError("GROK_BOT_PROFILE_TIMEOUT");
    }
    throw new GrokBotError(code || "GROK_BOT_PROFILE_UNREADABLE");
  }
  try { return JSON.parse(output) as GrokBotProfileSnapshot; }
  catch (error) {
    if (error instanceof GrokBotError) throw error;
    throw new GrokBotError("GROK_BOT_PROFILE_INVALID");
  }
}
/** At most four verified profiles remain in memory. Every access rehashes protected
 * disk inputs; changed files, expired JWTs and failed reads never reuse a credential. */
export async function readGrokBotNativeProfile(options: NativeProfileOptions = {}): Promise<GrokBotCredentials> {
  if (process.platform !== "win32") throw new GrokBotError("GROK_BOT_PLATFORM_UNSUPPORTED");
  const profilePath = grokBotProfilePath(options.profilePath);
  const script = grokBotProfileScriptPath(options);
  const timeoutMs = boundedTimeout(options.timeoutMs, 30_000);
  let helperIdentity = 0;
  if (options.runProfileHelper) {
    helperIdentity = helperIdentities.get(options.runProfileHelper) ?? ++nextHelperIdentity;
    helperIdentities.set(options.runProfileHelper, helperIdentity);
  }
  const key = JSON.stringify([profilePath, script, options.powershellPath || "powershell.exe", helperIdentity]);
  let fingerprint: string;
  try { fingerprint = await protectedProfileFingerprint(profilePath); }
  catch (error) { profileCredentials.delete(key); throw error; }
  const cached = profileCredentials.get(key);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
    profileCredentials.delete(key); profileCredentials.set(key, cached);
    return { ...cached.credentials };
  }
  profileCredentials.delete(key);
  const pending = profileReads.get(key);
  if (pending) {
    if (pending.fingerprint !== fingerprint) {
      await pending.promise.catch(() => {});
      throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    }
    const credentials = await pending.promise;
    if (await protectedProfileFingerprint(profilePath) !== fingerprint) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    return { ...credentials };
  }
  const promise = (async () => {
    const snapshot = await runNativeProfileHelper(options, profilePath, script, timeoutMs);
    if (await protectedProfileFingerprint(profilePath) !== fingerprint) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    const credentials = decodeGrokBotProfileSnapshot(snapshot);
    const expiresAt = Number(record(JSON.parse(Buffer.from(credentials.accessToken.split(".")[1], "base64url").toString())).exp) * 1000;
    profileCredentials.set(key, { fingerprint, expiresAt, credentials: Object.freeze({ ...credentials }) });
    while (profileCredentials.size > 4) profileCredentials.delete(profileCredentials.keys().next().value!);
    return credentials;
  })();
  profileReads.set(key, { fingerprint, promise });
  try { return { ...await promise }; }
  finally { if (profileReads.get(key)?.promise === promise) profileReads.delete(key); }
}

/** One native HTTP transport to the existing cloud owner; no routine/runtime fallback. */
export class GrokBotClient {
  readonly backendUrl: string;
  private readonly options: GrokBotClientOptions;
  constructor(options: GrokBotClientOptions = {}) {
    boundedTimeout(options.timeoutMs, 30_000);
    this.options = options;
    this.backendUrl = normalizeGrokBotBackendUrl(options.backendUrl);
    if (typeof options.readProfile !== "function" && new URL(this.backendUrl).origin !== new URL(DEFAULT_GROK_BOT_BACKEND_URL).origin) {
      throw new GrokBotError("GROK_BOT_BACKEND_MISMATCH");
    }
  }
  async profileStatus(): Promise<{ signedIn: true; accountScope: string; appVersion?: string; profilePath: string }> {
    const profile = await this.credentials();
    return { signedIn: true, accountScope: profile.accountScope, appVersion: profile.appVersion, profilePath: grokBotProfilePath(this.options.profilePath) };
  }
  private async credentials(): Promise<GrokBotCredentials> {
    try { return await (this.options.readProfile || (() => readGrokBotNativeProfile(this.options)))(); }
    catch (error) {
      if (error instanceof GrokBotError) throw error;
      throw new GrokBotError("GROK_BOT_PROFILE_UNREADABLE");
    }
  }
  private async call(method: string, body: unknown, expectedAccountScope?: string): Promise<Record<string, unknown>> {
    const credentials = await this.credentials();
    if (expectedAccountScope && credentials.accountScope !== expectedAccountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    const headers: Record<string, string> = { "content-type": "application/json", "connect-protocol-version": "1",
      authorization: "Bearer " + credentials.accessToken, "x-cursor-client-type": "sand",
      "x-cursor-client-os": process.platform === "win32" ? "windows" : process.platform, "x-cursor-client-source": "desktop" };
    if (credentials.selectedTeamId) headers["x-cursor-team-id"] = credentials.selectedTeamId;
    if (credentials.appVersion) headers["x-cursor-client-version"] = credentials.appVersion;
    let response: Response;
    try {
      response = await (this.options.request || fetch)(new URL("/" + SERVICE_PATH + method, this.backendUrl), {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(boundedTimeout(this.options.timeoutMs, 20_000)), redirect: "error" });
    } catch { throw new GrokBotError("GROK_BOT_TRANSPORT_UNAVAILABLE", { uncertain: true }); }
    if (!response.ok) {
      const status = response.status;
      const code = status === 401 ? "GROK_BOT_LOGIN_EXPIRED" : status === 403 ? "GROK_BOT_OWNER_REFUSED" : `GROK_BOT_HTTP_FAILED:${status}`;
      // Method name and status only; never headers, tokens or bodies.
      console.warn(`[grokBot] ${method} failed with HTTP ${status}`);
      throw new GrokBotError(code, { httpStatus: status, method, retryable: status === 429 || status === 408 || status >= 500,
        uncertain: status >= 500 || status === 408 || status === 429 });
    }
    try {
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new Error();
      const result = record(JSON.parse(text));
      if (method === "SendGrokBotUserMessage" || method === "SendGrokBotAgentMessage") {
        let current: GrokBotCredentials;
        try { current = await this.credentials(); }
        catch { throw new GrokBotError("GROK_BOT_OWNER_CHECK_UNCONFIRMED", { uncertain: true }); }
        if (current.accountScope !== credentials.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED", { uncertain: true });
      }
      return result;
    } catch (error) {
      if (error instanceof GrokBotError) throw error;
      throw new GrokBotError("GROK_BOT_RESPONSE_INVALID", { uncertain: true });
    }
  }
  async listBots(expectedAccountScope?: string): Promise<GrokBotRoster> {
    const response = await this.call("ListGrokBotAgents", {}, expectedAccountScope);
    const agents = response.agents ?? [];
    if (!Array.isArray(agents)) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
    const bots = agents.map(value => {
      const bot = record(value);
      if (typeof bot.name !== "string" || !bot.name.trim()) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
      if (bot.memberAgentIds !== undefined && !Array.isArray(bot.memberAgentIds)) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
      return { agentId: opaque(bot.agentId), name: bot.name,
        kind: typeof bot.kind === "string" || typeof bot.kind === "number" ? bot.kind : undefined,
        memberAgentIds: Array.isArray(bot.memberAgentIds) ? bot.memberAgentIds.map(opaque) : undefined,
        harness: typeof bot.harness === "string" ? bot.harness : undefined,
        viewerSessionId: typeof bot.viewerSessionId === "string" && bot.viewerSessionId ? bot.viewerSessionId : undefined, updatedAtMs: int64(bot.updatedAtMs) };
    });
    if (new Set(bots.map(bot => bot.agentId)).size !== bots.length) throw new GrokBotError("GROK_BOT_DUPLICATE_OWNER_ID");
    return { bots, truncated: response.truncated === true };
  }
  async listSessions(agentId: string, expectedAccountScope?: string): Promise<GrokBotNativeSession[]> {
    opaque(agentId);
    const scope = expectedAccountScope || (await this.profileStatus()).accountScope;
    const bots = (await this.listBots(scope)).bots.filter(bot => bot.agentId === agentId);
    if (bots.length !== 1) throw new GrokBotError("GROK_BOT_SESSION_NOT_FOUND");
    if (isGrokBotRoom(bots[0])) return [{ agentId, sessionId: "", defaultMain: true, kind: "MAIN" }];
    const response = await this.call("ListGrokBotAgentSessions", { agentId }, scope);
    const sessions = response.sessions ?? [];
    if (!Array.isArray(sessions)) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
    const listed: GrokBotNativeSession[] = sessions.flatMap(value => {
      const session = record(value);
      if (session.agentId !== agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      if (session.sessionId === "") return [];
      return [{ agentId, sessionId: opaque(session.sessionId), kind: typeof session.kind === "string" || typeof session.kind === "number" ? session.kind : undefined,
        createdAtMs: int64(session.createdAtMs), updatedAtMs: int64(session.updatedAtMs), lastActivityAtMs: int64(session.lastActivityAtMs) }];
    });
    if (bots[0].harness === "temporal") {
      // Temporal's existing main transcript uses the native empty address. The
      // canonical marker is emitted only after owner roster and transcript proof.
      await this.readTranscript(agentId, "", { defaultMain: true, accountScope: scope, limit: 1 });
      listed.unshift({ agentId, sessionId: "", defaultMain: true, kind: "MAIN" });
    }
    return listed;
  }
  async readTranscript(agentId: string, sessionId: string, options: { limit?: number; generation?: number; beforeSeq?: string; defaultMain?: true; accountScope?: string } = {}): Promise<GrokBotTranscriptPage> {
    const response = await this.call("ListGrokBotTranscriptEntries", { agentId: opaque(agentId), sessionId: nativeSessionId(sessionId, options.defaultMain),
      limit: Math.max(1, Math.min(500, Math.floor(options.limit ?? 50))), ...(options.generation === undefined ? {} : { generation: options.generation }),
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }) }, options.accountScope);
    const entries = response.entries ?? [];
    if (!Array.isArray(entries)) throw new GrokBotError("GROK_BOT_RESPONSE_INVALID");
    return { entries, generation: typeof response.generation === "number" ? response.generation : 0,
      cloudAgentPeerIds: Array.isArray(response.cloudAgentPeerIds) ? response.cloudAgentPeerIds.filter((id): id is string => typeof id === "string") : [],
      cloudAgentPeerIdsKnown: response.cloudAgentPeerIdsKnown === true };
  }
  async getSendStatus(agentId: string, sessionId: string, messageId: string, accountScope?: string, options: { defaultMain?: true } = {}): Promise<GrokBotSendStatus> {
    const ownerId = opaque(agentId), nativeId = nativeSessionId(sessionId, options.defaultMain), originalMessageId = opaque(messageId);
    const scope = accountScope || (await this.profileStatus()).accountScope;
    let targetAgentId = ownerId, targetSessionId = nativeId;
    if (!options.defaultMain) {
      const roster = await this.listBots(scope);
      const room = roster.bots.find(bot => bot.agentId === nativeId && isGrokBotRoom(bot));
      if (room) {
        verifyGrokBotRoomMember(roster, ownerId, room);
        targetAgentId = room.agentId;
        targetSessionId = "";
      }
    }
    const response = await this.call("GetGrokBotSendStatus", { agentId: targetAgentId, sessionId: targetSessionId, messageId: originalMessageId }, scope);
    const statusMap: Record<string, GrokBotSendStatus["status"]> = { "0": "unknown-durability", "1": "not-found", "2": "accepted", "3": "rejected", "4": "pending", "5": "unknown-durability",
      GROK_BOT_SEND_STATUS_UNSPECIFIED: "unknown-durability", GROK_BOT_SEND_STATUS_NOT_FOUND: "not-found", GROK_BOT_SEND_STATUS_ACCEPTED: "accepted",
      GROK_BOT_SEND_STATUS_REJECTED: "rejected", GROK_BOT_SEND_STATUS_PENDING: "pending", GROK_BOT_SEND_STATUS_UNKNOWN_DURABILITY: "unknown-durability",
      UNSPECIFIED: "unknown-durability", NOT_FOUND: "not-found", ACCEPTED: "accepted", REJECTED: "rejected", PENDING: "pending", UNKNOWN_DURABILITY: "unknown-durability" };
    const status = statusMap[String(response.status ?? 0)] || "unknown-durability";
    return { status, echoEntryId: typeof response.echoEntryId === "string" ? response.echoEntryId : undefined,
      rejectionCode: typeof response.rejectionCode === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(response.rejectionCode) ? response.rejectionCode : undefined,
      acceptedAtMs: int64(response.acceptedAtMs) };
  }
  async sendNative(input: GrokBotSendInput, expectedAccountScope?: string): Promise<GrokBotSendReceipt> {
    const agentId = opaque(input.agentId), sessionId = nativeSessionId(input.sessionId, input.defaultMain), messageId = opaque(input.messageId);
    if (!input.text.trim()) throw new GrokBotError("GROK_BOT_MESSAGE_REQUIRED");
    const account = await this.profileStatus();
    if (expectedAccountScope && account.accountScope !== expectedAccountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    const roster = await this.listBots(account.accountScope);
    const roomAlias = input.deliveryType === "group" && !input.defaultMain;
    const target = roster.bots.find(bot => bot.agentId === (roomAlias ? sessionId : agentId));
    if (!target) throw new GrokBotError("GROK_BOT_SESSION_NOT_FOUND");
    const room = isGrokBotRoom(target);
    if (input.deliveryType && input.deliveryType !== (room ? "group" : "private")) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
    const fromAgentId = input.fromAgentId === undefined ? undefined : opaque(input.fromAgentId);
    if (roomAlias) {
      if (!room) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
      if (fromAgentId !== undefined && fromAgentId !== agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      verifyGrokBotRoomMember(roster, agentId, target);
    }
    if (fromAgentId !== undefined) {
      const sender = roster.bots.find(bot => bot.agentId === fromAgentId);
      if (!sender || !isGrokBotAgent(sender)) throw new GrokBotError("GROK_BOT_SENDER_NOT_FOUND");
      if (room && !target.memberAgentIds?.includes(fromAgentId)) throw new GrokBotError("GROK_BOT_SENDER_NOT_MEMBER");
    }
    if (fromAgentId !== undefined) {
      if (!roomAlias && (!input.defaultMain || sessionId !== "")) throw new GrokBotError("GROK_BOT_NATIVE_TARGET_REQUIRES_MAIN");
      const replyToId = input.replyToId === undefined ? undefined : opaque(input.replyToId);
      let nativeResponse: Record<string, unknown>;
      try {
        nativeResponse = await this.call("SendGrokBotAgentMessage", { toAgentId: target.agentId, messageId, text: input.text,
          sentAtMs: String(Date.now()), ...(fromAgentId === undefined ? {} : { fromAgentId }), ...(replyToId === undefined ? {} : { replyToId }) }, account.accountScope);
      } catch (error) {
        if (!(error instanceof GrokBotError) || !error.uncertain) throw error;
        throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
      }
      const delivery = String(nativeResponse.delivery ?? 0).replace(/^GROK_BOT_AGENT_MESSAGE_DELIVERY_/, "");
      if (["4", "5", "6", "7", "8", "TARGET_NOT_FOUND", "FORBIDDEN", "BOX_UNREACHABLE", "TEMPORAL_UNAVAILABLE", "INVALID_TARGET"].includes(delivery)) {
        throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
      }
      if (!["1", "2", "3", "DELIVERED_TEMPORAL", "DELIVERED_BOX", "DUPLICATE"].includes(delivery)) throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
      if (nativeResponse.targetAgentId !== target.agentId) throw new GrokBotError("GROK_BOT_RECEIPT_OWNER_MISMATCH", { uncertain: true });
      return { accepted: true, agentId, sessionId, messageId, duplicate: delivery === "3" || delivery === "DUPLICATE", recovered: false,
        targetAgentId: target.agentId, targetName: typeof nativeResponse.targetName === "string" ? nativeResponse.targetName : undefined,
        workflowId: typeof nativeResponse.workflowId === "string" ? nativeResponse.workflowId : undefined };
    }
    const nativeAgentId = target.agentId, nativeSession = roomAlias ? "" : sessionId;
    const nativeMain = roomAlias ? true : input.defaultMain;
    const sessions = await this.listSessions(nativeAgentId, account.accountScope);
    if (!sessions.some(session => session.sessionId === nativeSession && session.defaultMain === nativeMain)) throw new GrokBotError("GROK_BOT_SESSION_NOT_FOUND");
    let response: Record<string, unknown>;
    try {
      response = await this.call("SendGrokBotUserMessage", { agentId: nativeAgentId, sessionId: nativeSession, messageId, text: input.text, sentAtMs: String(Date.now()) }, account.accountScope);
    } catch (error) {
      if (!(error instanceof GrokBotError) || !error.uncertain) throw error;
      // A lost response is resolved by the original messageId. Never repeat send.
      let status: GrokBotSendStatus | undefined;
      try { status = await this.getSendStatus(agentId, sessionId, messageId, account.accountScope, { defaultMain: input.defaultMain }); } catch { /* Keep the original uncertain result. */ }
      if (status?.status === "accepted") return { accepted: true, agentId, sessionId, messageId, duplicate: false, recovered: true, echoEntryId: status.echoEntryId };
      if (status?.status === "rejected") throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
      throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
    }
    const delivery = String(response.delivery ?? 0);
    if (["1", "2", "3", "ACCEPTED_BOX", "ACCEPTED_TEMPORAL", "DUPLICATE", "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX", "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL", "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE"].includes(delivery)) {
      return { accepted: true, agentId, sessionId, messageId, duplicate: delivery === "3" || delivery === "DUPLICATE" || delivery.endsWith("_DUPLICATE"), recovered: false };
    }
    if (delivery === "4" || delivery === "REFUSED" || delivery.endsWith("_REFUSED")) throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
    throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { localIdentitySettingsRequest } from "./identityResetRoutes.js";
import { hasTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { rabiLinkTransportAssertionPresent } from "./rabiLinkAgentDeviceConnection.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";

type Account = { id: string; username: string };
type Credentials = { account: Account; token: string; legacyCompatible: boolean };
type Session = Credentials & { server: string; deviceId: string; deviceGuid: string; legacyTokenHash: string };
type Rotation = Omit<Session, keyof Credentials> & { token: string; requestId: string };
type StoredState = { session?: Session; rotation?: Rotation; migrationDismissed?: boolean };
type Action = "login" | "register" | "migrate" | "logout" | "recover" | "confirm";
type Reply = Omit<Credentials, "token"> & { token?: string; receipt?: { requestId: string; state: "staged" | "confirmed" } };
type LocalConfig = { relay: RabiLinkRelayGlobalConfig; deviceGuid: string; deviceName: string };
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

class HostAccountError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function serverAddress(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HostAccountError(400, "请先保存服务器地址。"); }
  if (url.username || url.password || url.hash || url.search
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new HostAccountError(400, "请使用 HTTPS 服务器地址。");
  }
  return url.href.replace(/\/+$/, "");
}

export class RabiLinkHostAccount {
  private state: StoredState;
  private pending = false;
  private migrationAttempted = "";
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryAttempts = 0;

  constructor(private readonly options: {
    file: string;
    config(): LocalConfig;
    changed(): Promise<void>;
    request?: typeof fetch;
    readJson(request: IncomingMessage, maxBytes: number): Promise<unknown>;
    json(response: ServerResponse, status: number, data: unknown): void;
  }) {
    try { this.state = JSON.parse(readFileSync(options.file, "utf8")) as StoredState ?? {}; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("RabiLink account state is unavailable. Sign in again from RabiLink.");
      this.state = { migrationDismissed: (error as NodeJS.ErrnoException).code !== "ENOENT" };
    }
  }

  private save(state: StoredState) {
    atomicWriteFileSync(this.options.file, JSON.stringify(state), { mode: 0o600 });
    this.state = state;
  }

  session(): Readonly<Session> | undefined {
    const { session } = this.state;
    if (!session) return;
    const { relay, deviceGuid } = this.options.config();
    if (!relay.enabled || session.deviceGuid !== deviceGuid) return;
    if (relay.token && session.legacyTokenHash !== fingerprint(relay.token)) return;
    try { if (session.server === serverAddress(relay.url)) return session; } catch { return; }
  }

  relay(): (RabiLinkRelayGlobalConfig & { accountId: string }) | undefined {
    const session = this.session();
    if (session) return { ...this.options.config().relay, url: session.server, token: session.token, deviceId: session.deviceId, accountId: session.account.id };
  }

  status() { return { account: this.session()?.account ?? null }; }

  private async handleAvatar(request: IncomingMessage, json: (status: number, body: unknown) => void, readOnly: boolean, authorize: () => boolean) {
    const method = request.method;
    if (method !== "GET" && method !== "POST") return json(405, {});
    if (method === "POST" && readOnly) return json(423, { message: "当前处于只读模式。" });
    const session = this.session();
    if (!session) return json(401, { message: "请先登录 Rabi 账号。" });
    try {
      const body = method === "POST" ? await this.options.readJson(request, 176000) as { accountId?: unknown; avatar?: unknown } | null : undefined;
      if (!authorize()) return json(403, { message: "WebGUI 访问授权已失效，请重新打开界面。" });
      if (this.session() !== session || (method === "POST" && body?.accountId !== session.account.id)) {
        return json(409, { message: "账号已更改，请重试。" });
      }
      const upstream = await (this.options.request ?? fetch)(`${session.server}/api/rabilink/host-account/avatar`, {
        method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", "x-rabilink-token": session.token },
        ...(method === "POST" ? { body: JSON.stringify({ avatar: body?.avatar }) } : {})
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if (upstream.status === 404) return json(404, { code: "RABILINK_RELAY_AVATAR_UNAVAILABLE", message: "此服务器版本暂不支持头像。" });
        if (upstream.status === 400) return json(400, { message: "头像图片无效，请重新选择。" });
        if (upstream.status === 401) return json(401, { message: "登录已失效，请重新登录。" });
        throw new Error("Relay avatar request failed");
      }
      const result = await upstream.json() as { code?: number; data?: { avatar?: string | null } };
      if (this.session() !== session) return json(409, { message: "账号已更改，请重试。" });
      const avatar = result.data?.avatar;
      if (result.code !== 0 || (avatar !== null && (typeof avatar !== "string" || avatar.length > 175000))) throw new Error("Invalid Relay avatar response");
      return json(200, { accountId: session.account.id, avatar });
    } catch {
      return json(502, { message: "暂时无法读取或保存头像，请稍后重试。" });
    }
  }

  private async handleProfile(request: IncomingMessage, json: (status: number, body: unknown) => void, readOnly: boolean, authorize: () => boolean) {
    const method = request.method;
    if (method !== "GET" && method !== "POST") return json(405, {});
    if (method === "POST" && readOnly) return json(423, { message: "当前处于只读模式。" });
    const session = this.session();
    if (!session) return json(401, { message: "请先登录 Rabi 账号。" });
    try {
      const body = method === "POST" ? await this.options.readJson(request, 4096) as { accountId?: unknown; username?: unknown } | null : undefined;
      if (!authorize()) return json(403, { message: "WebGUI 访问授权已失效，请重新打开界面。" });
      if (this.session() !== session || (method === "POST" && body?.accountId !== session.account.id)) {
        return json(409, { message: "账号已更改，请重试。" });
      }
      const upstream = await (this.options.request ?? fetch)(`${session.server}/api/rabilink/host-account/profile`, {
        method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", "x-rabilink-token": session.token },
        ...(method === "POST" ? { body: JSON.stringify({ username: body?.username }) } : {})
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if (upstream.status === 404) return json(404, { code: "RABILINK_RELAY_PROFILE_UNAVAILABLE", message: "此服务器版本暂不支持修改用户名。" });
        if (upstream.status === 400) return json(400, { message: "用户名需要 3-48 位，可使用中文、字母、数字、下划线、点、@ 或短横线。" });
        if (upstream.status === 409) return json(409, { message: "该用户名已被使用，请换一个。" });
        if (upstream.status === 401) return json(401, { message: "登录已失效，请重新登录。" });
        throw new Error("Relay profile request failed");
      }
      const result = await upstream.json() as { code?: number; data?: { account?: { id?: unknown; username?: unknown } } };
      if (this.session() !== session) return json(409, { message: "账号已更改，请重试。" });
      const account = result.data?.account;
      if (result.code !== 0 || account?.id !== session.account.id
        || typeof account?.username !== "string" || !account.username.trim() || account.username.length > 48) {
        throw new Error("Invalid Relay profile response");
      }
      if (method === "POST" && account.username !== session.account.username) {
        this.save({ ...this.state, session: { ...session, account: { id: session.account.id, username: account.username } } });
      }
      return json(200, { accountId: session.account.id, username: account.username });
    } catch {
      return json(502, { message: "暂时无法读取或保存用户名，请稍后重试。" });
    }
  }

  private async exchange(server: string, action: Action, body: object, token?: string): Promise<Reply | undefined> {
    const response = await (this.options.request ?? fetch)(`${server}/api/rabilink/host-account/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", ...(token ? { "x-rabilink-token": token } : {}) }, body: JSON.stringify(body)
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (action === "logout" && response.status === 401) return;
      const messages: Record<number, string> = { 400: "请检查账号、密码和设备信息。", 401: "账号或密码不正确。", 403: "请登录 Rabi 账号。", 404: "此服务器版本暂不支持账号连接。", 409: "账号已存在，或设备标识已被使用。", 429: "操作太频繁，请稍后再试。" };
      throw new HostAccountError(response.status, messages[response.status] || "服务器暂时无法完成账号操作。");
    }
    const result = await response.json() as { code?: number; data?: Reply };
    if (action === "logout") return;
    const credentials = result.data;
    if (result.code !== 0 || !credentials?.account || typeof credentials.account.id !== "string"
      || typeof credentials.account.username !== "string" || typeof credentials.legacyCompatible !== "boolean"
      || (!credentials.receipt && !/^rbw_[A-Za-z0-9_-]{43}$/.test(credentials.token || ""))) {
      throw new HostAccountError(502, "服务器返回了无效的账号凭据。");
    }
    return credentials;
  }

  private currentRotation(rotation: Rotation): boolean {
    const { relay, deviceGuid } = this.options.config();
    if (!relay.enabled || rotation.deviceGuid !== deviceGuid || rotation.deviceId !== (relay.deviceId || `pc-${deviceGuid}`)
      || rotation.legacyTokenHash !== fingerprint(relay.token)) return false;
    try { return rotation.server === serverAddress(relay.url); } catch { return false; }
  }

  private async complete(rotation: Rotation, reply: Reply) {
    if (!this.currentRotation(rotation)) throw new HostAccountError(409, "服务器或本机身份已更改，请重试。");
    const { requestId, token, ...identity } = rotation;
    if (reply.receipt) {
      if (reply.receipt.requestId !== requestId || !["staged", "confirmed"].includes(reply.receipt.state)) throw new HostAccountError(502, "服务器返回了其他账号操作的回执。");
      if (reply.receipt.state === "staged") {
        const confirmed = await this.exchange(rotation.server, "confirm", { requestId, deviceId: rotation.deviceId, deviceGuid: rotation.deviceGuid }, token);
        if (confirmed?.receipt?.requestId !== requestId || confirmed.receipt.state !== "confirmed" || confirmed.account.id !== reply.account.id) {
          throw new HostAccountError(502, "服务器未确认原设备凭据。");
        }
        reply = confirmed;
      }
    }
    if (!this.currentRotation(rotation)) throw new HostAccountError(409, "服务器或本机身份已更改，请重试。");
    const previous = this.state.session;
    const session: Session = { ...identity, account: reply.account, legacyCompatible: reply.legacyCompatible, token: reply.receipt ? token : reply.token! };
    this.save({ session });
    this.recoveryAttempts = 0;
    if (previous && previous.token !== session.token) await this.exchange(previous.server, "logout", {}, previous.token).catch(() => {});
    await this.options.changed();
  }

  private async recoverRotation(): Promise<boolean> {
    const rotation = this.state.rotation;
    if (!rotation) return false;
    if (!this.currentRotation(rotation)) { this.save({ ...this.state, rotation: undefined }); return false; }
    try {
      const reply = await this.exchange(rotation.server, "recover", { requestId: rotation.requestId, deviceId: rotation.deviceId, deviceGuid: rotation.deviceGuid }, rotation.token);
      if (!reply?.receipt) throw new HostAccountError(502, "无法读取原账号操作回执。");
      await this.complete(rotation, reply);
      return true;
    } catch (error) {
      if (error instanceof HostAccountError && [404, 409].includes(error.statusCode)) {
        this.save({ ...this.state, rotation: undefined });
        return false;
      }
      throw error;
    }
  }

  private scheduleRecovery() {
    if (this.recoveryTimer || !this.state.rotation || this.recoveryAttempts >= 7) return;
    const delay = Math.min(30000, 1000 * 2 ** this.recoveryAttempts++);
    this.recoveryTimer = setTimeout(() => { this.recoveryTimer = undefined; void this.tryRecover(); }, delay);
    this.recoveryTimer.unref();
  }

  async tryRecover(): Promise<void> {
    if (this.pending || !this.state.rotation) return;
    this.pending = true;
    try { await this.recoverRotation(); }
    catch { this.scheduleRecovery(); }
    finally { this.pending = false; }
  }

  private async connect(action: "login" | "register" | "migrate", input: unknown) {
    const { relay, deviceGuid, deviceName } = this.options.config();
    if (!relay.enabled) throw new HostAccountError(400, "请开启服务器连接并保存。");
    const server = serverAddress(relay.url);
    const deviceId = relay.deviceId || `pc-${deviceGuid}`;
    const body = input as { username?: unknown; password?: unknown } | null;
    if (await this.recoverRotation()) {
      if (action === "migrate" || typeof body?.username !== "string" || this.session()?.account.username.toLowerCase() === body.username.trim().toLowerCase()) return;
    }
    const rotation = { server, deviceId, deviceGuid, legacyTokenHash: fingerprint(relay.token), requestId: randomUUID(), token: `rbw_${randomBytes(32).toString("base64url")}` };
    this.recoveryAttempts = 0;
    this.save({ ...this.state, rotation });
    let reply: Reply | undefined;
    try {
      reply = await this.exchange(server, action, { username: body?.username, password: body?.password, deviceId, deviceGuid, deviceName,
        requestId: rotation.requestId, credentialHash: fingerprint(rotation.token) }, relay.token || undefined);
    } catch (error) {
      if (error instanceof HostAccountError && error.statusCode < 500) this.save({ ...this.state, rotation: undefined });
      else if (await this.recoverRotation().catch(() => false)) return;
      else this.scheduleRecovery();
      throw error;
    }
    if (!reply) throw new HostAccountError(502, "服务器没有返回设备凭据。");
    try { await this.complete(rotation, reply); }
    catch (error) {
      if (await this.recoverRotation().catch(() => false)) return;
      this.scheduleRecovery();
      throw error;
    }
  }

  async tryMigrate(): Promise<void> {
    const { relay } = this.options.config();
    if (this.pending || this.state.session || this.state.rotation || this.state.migrationDismissed || !relay.enabled || !relay.url || !relay.token.startsWith("rbw_")) return;
    const key = `${relay.url}\n${relay.deviceId}\n${relay.token}`;
    if (key === this.migrationAttempted) return;
    this.migrationAttempted = key;
    this.pending = true;
    try { await this.connect("migrate", {}); }
    catch { /* Keep the existing connection and allow account login from the same page. */ }
    finally { this.pending = false; }
  }

  async handle(request: IncomingMessage, url: URL, response: ServerResponse, readOnly: boolean, authorizeWebgui: () => boolean = () => false): Promise<boolean> {
    const avatarRequest = url.pathname === "/api/rabilink/host-account/avatar";
    const profileRequest = url.pathname === "/api/rabilink/host-account/profile";
    if (!avatarRequest && !profileRequest && url.pathname !== "/api/rabilink/host-account") return false;
    response.setHeader("cache-control", "no-store");
    const json = (status: number, body: unknown) => this.options.json(response, status, body);
    const local = localIdentitySettingsRequest(request);
    const authorize = () => !hasTrustedLanAgentPrincipal(request) && !rabiLinkTransportAssertionPresent(request)
      && (local || authorizeWebgui());
    if (!authorize()) { json(403, { message: "请使用已授权的 RabiRoute 界面操作账号。" }); return true; }
    if (avatarRequest) { await this.handleAvatar(request, json, readOnly, authorize); return true; }
    if (profileRequest) { await this.handleProfile(request, json, readOnly, authorize); return true; }
    if (request.method === "GET") { json(200, this.status()); return true; }
    if (request.method !== "POST") { json(405, {}); return true; }
    if (readOnly) { json(423, { message: "当前处于只读模式。" }); return true; }
    if (this.pending) { json(409, { message: "正在处理账号操作，请稍后重试。" }); return true; }
    this.pending = true;
    try {
      const body = await this.options.readJson(request, 4096) as { action?: unknown } | null;
      if (!authorize()) { json(403, { message: "WebGUI 访问授权已失效，请重新打开界面。" }); return true; }
      if (body?.action === "login" || body?.action === "register") await this.connect(body.action, body);
      else if (body?.action === "logout") {
        const { session, rotation } = this.state;
        if (rotation) await this.exchange(rotation.server, "logout", {}, rotation.token);
        if (session) await this.exchange(session.server, "logout", {}, session.token);
        this.save({ migrationDismissed: true });
        await this.options.changed();
      } else throw new HostAccountError(400, "请选择登录、注册或退出登录。");
      json(200, this.status());
    } catch (error) {
      json(error instanceof HostAccountError ? error.statusCode : 502, { message: error instanceof HostAccountError ? error.message : "账号操作失败，请检查服务器连接后重试。" });
    } finally { this.pending = false; }
    return true;
  }
}

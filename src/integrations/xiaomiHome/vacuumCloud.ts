import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cs2RelayOffer } from "./vacuumCs2Relay.js";
import { atomicWriteFileSync } from "../../shared/filePersistence.js";
import { createLocalSecretProtector, type LocalSecretProtector } from "../../shared/localSecretProtection.js";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { decodeXiaomiVacuumMap } from "./vacuumMapDecoder.js";
import { planVacuumMapPath } from "./vacuumPath.js";
import { parseVacuumTrajectory, vacuumTrajectoryContracts, VacuumTrajectoryParseError } from "./vacuumTrajectory.js";
import { parseVacuumPosition, vacuumPositionContracts, VacuumPositionParseError } from "./vacuumPosition.js";
import { parseVacuumTelemetry, vacuumTelemetryContracts } from "./vacuumTelemetry.js";
import {vacuumFeedbackIdentity, prepareVacuumFeedback, consumeVacuumFeedback} from "./vacuumFeedback.js";
import { VacuumVideoTransport, type VacuumVideoProvision } from "./vacuumVideo.js";

type CloudSession = { userId: string; ssecurity: string; serviceToken: string };
type Login = { id: string; expiresAt: number; imageDataUrl?: string; pollUrl?: string; connected: boolean; poll?: Promise<unknown> };
type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean; hostOnly: boolean };
export type VacuumCloudDevice = { deviceId: string; model: string; name: string; online: boolean };
type CloudMapResult = { schemaVersion: number; device: VacuumCloudDevice; slot: string; observedAt: string; byteLength: number; sha256: string; blobBase64: string } & (ReturnType<typeof decodeXiaomiVacuumMap> | { decoded: false; decodeState: string; coordinateNavigation: false });
const REGIONS = new Set(["cn", "de", "us", "ru", "tw", "sg", "in", "i2"]);
const LOGIN_TTL = 5 * 60_000;
const MAX_BLOB = 16 * 1024 * 1024;

function failure(code: string, message: string, status = 502): never {
  throw new XiaomiHomeManagerApiError(status, `xiaomi_vacuum_cloud_${code}`, message);
}

// Login redirects never leave Xiaomi; file downloads never carry login cookies.
export function validatedCloudUrl(input: string, download = false): URL {
  let url: URL;
  try { url = new URL(input); } catch { return failure("url_invalid", "Xiaomi returned an invalid URL."); }
  const host = url.hostname.toLowerCase();
  const roots = download ? ["mi.com", "xiaomi.com", "mi-img.com", "xiaomi.net", "fds.api.xiaomi.com"] : ["mi.com", "xiaomi.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !roots.some(root => host === root || host.endsWith(`.${root}`))) {
    return failure("url_invalid", "Xiaomi returned a URL outside its HTTPS service domains.");
  }
  return url;
}

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") || 0) > maximum) failure("size_limit", "Xiaomi response exceeds the size limit.");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maximum) { await reader.cancel(); failure("size_limit", "Xiaomi response exceeds the size limit."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function accountJson(raw: Buffer): any {
  try { return JSON.parse(raw.toString("utf8").replace(/^&&&START&&&/, "")); }
  catch { return failure("response_invalid", "Xiaomi returned an invalid account response."); }
}

// RC4-drop1024, as used by the Mi Home cloud protocol. Fresh state for each field.
export function cloudRc4(key: Buffer, input: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % key.length]!) & 255; [state[i], state[j]] = [state[j]!, state[i]!]; }
  let i = 0; j = 0;
  const result = Buffer.alloc(input.length);
  for (let n = 0; n < input.length + 1024; n++) {
    i = (i + 1) & 255; j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    if (n >= 1024) result[n - 1024] = input[n - 1024]! ^ state[(state[i]! + state[j]!) & 255]!;
  }
  return result;
}

export function cloudSignature(url: URL, signedNonce: string, params: Record<string, string>): string {
  const parts = ["POST", url.pathname.replace(/^\/app\//, "/"), ...Object.entries(params).map(([key, value]) => `${key}=${value}`), signedNonce];
  return createHash("sha1").update(parts.join("&")).digest("base64");
}

/** Sole owner of Mi Home credentials; read-only maps/trajectory and bounded, explicit video sessions. */
export class XiaomiVacuumCloud {
  private readonly file: string;
  private session?: CloudSession;
  private login?: Login;
  private beginning?: Promise<unknown>;
  private loginKey?: string;
  private cookies: Cookie[] = [];
  private readonly mapReads = new Map<string, Promise<CloudMapResult>>();
  readonly video: VacuumVideoTransport;
  private readonly agent = `${randomBytes(9).toString("hex")}-ABCDEABCDEABC APP/com.xiaomi.mihome APPV/10.5.201`;

  constructor(
    private readonly runtimeDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly protector: LocalSecretProtector = createLocalSecretProtector(runtimeDir, ".vacuum-cloud.key")
  ) {
    this.file = path.join(runtimeDir, "vacuum-cloud-session.json");
    this.video = new VacuumVideoTransport(runtimeDir, (deviceId, region, password, rememberPassword) => this.videoSource(deviceId, region, password, rememberPassword));
  }

  private passwordFile(deviceId: string, region: string): string {
    if (!/^\d{1,32}$/.test(deviceId) || !REGIONS.has(region)) failure("video_password_invalid", "Invalid device or region.", 400);
    const session = this.resolve();
    if (!session) failure("session_unavailable", "Connect the Mi Home cloud account first.", 409);
    const scope = createHash("sha256").update(JSON.stringify([session.userId, region, deviceId])).digest("hex");
    return path.join(this.runtimeDir, "vacuum-video-passwords", `${scope}.json`);
  }

  private savedPassword(deviceId: string, region: string): string | undefined {
    const file = this.passwordFile(deviceId, region);
    if (!fs.existsSync(file)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.schemaVersion !== 1 || data.protection !== this.protector.scheme) throw Error("scheme");
      if (data.forgotten === true) return undefined;
      const password = this.protector.unprotect(data.protectedPassword);
      if (!/^\d{4}$/.test(password)) throw Error("format");
      return password;
    } catch { return failure("video_password_unavailable", "本机视频密码无法解密，请删除后重新输入。", 409); }
  }

  videoPasswordStatus(deviceId: string, region = "cn") {
    return { saved: this.savedPassword(deviceId, region) !== undefined };
  }

  private savePassword(deviceId: string, region: string, password: string): void {
    atomicWriteFileSync(this.passwordFile(deviceId, region), JSON.stringify({ schemaVersion: 1,
      protection: this.protector.scheme, protectedPassword: this.protector.protect(password) }), { mode: 0o600 });
    recordDataMutationAudit({ group: "integration.xiaomi-home", event: "vacuum.video-password", owner: "XiaomiVacuumCloud",
      action: "save-verified-password", target: { type: "vacuum", id: deviceId }, dataSource: { kind: "file", id: "vacuum-video-passwords" }, outcome: "committed" });
  }

  videoPasswordReceipt(key: string): { state: string; saved: boolean } {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) failure("key_required", "Supply a stable action key.", 400);
    const file = path.join(this.runtimeDir, "vacuum-video-password-keys", `${createHash("sha256").update(key).digest("hex")}.json`);
    if (!fs.existsSync(file)) failure("receipt_not_found", "Password action receipt not found.", 404);
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    return { state: receipt.state, saved: false };
  }

  forgetVideoPassword(deviceId: string, region: string, key: string) {
    const target = this.passwordFile(deviceId, region);
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) failure("key_required", "Supply a stable action key.", 400);
    const file = path.join(this.runtimeDir, "vacuum-video-password-keys", `${createHash("sha256").update(key).digest("hex")}.json`);
    if (fs.existsSync(file)) {
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (receipt.scope !== path.basename(target)) failure("key_conflict", "Password action key belongs to another device/account.", 409);
      return this.videoPasswordReceipt(key);
    }
    // Persist uncertainty before mutation: replay never deletes a subsequently saved replacement.
    atomicWriteFileSync(file, JSON.stringify({ state: "uncertain", scope: path.basename(target) }), { mode: 0o600 });
    atomicWriteFileSync(target, JSON.stringify({ schemaVersion: 1, protection: this.protector.scheme, forgotten: true }), { mode: 0o600 });
    atomicWriteFileSync(file, JSON.stringify({ state: "completed", scope: path.basename(target) }), { mode: 0o600 });
    recordDataMutationAudit({ group: "integration.xiaomi-home", event: "vacuum.video-password", owner: "XiaomiVacuumCloud",
      action: "forget-password", target: { type: "vacuum", id: deviceId }, dataSource: { kind: "file", id: "vacuum-video-passwords" }, outcome: "committed" });
    return { state: "completed", saved: false };
  }

  /** MISS keys remain internal to this provider and its owned, video-only transport. */
  private async cameraDevice(deviceId: string, region: string): Promise<{ model: string; localip: string }> {
    if (!/^\d{1,32}$/.test(deviceId)) failure("query_invalid", "Supply a numeric device ID.", 400);
    const list = await this.call(region, "/home/device_list", { getVirtualModel: false, getHuamiDevices: 0 });
    const device = list.code === 0 && Array.isArray(list.result?.list) ? list.result.list.find((d: any) => String(d.did) === deviceId) : undefined;
    if (!device || !vacuumTrajectoryContracts[device.model]) failure("video_unsupported", "No verified MISS camera contract exists for this owned vacuum.", 422);
    const octets = typeof device.localip === "string" ? device.localip.split(".").map(Number) : [];
    if (octets.length !== 4 || octets.some((n: number) => !Number.isInteger(n) || n < 0 || n > 255)
      || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)) failure("video_lan_unavailable", "The owned vacuum has no valid private LAN address.", 409);
    return { model: device.model, localip: device.localip };
  }

  async videoNetwork(deviceId: string, region = "cn") {
    const device = await this.cameraDevice(deviceId, region);
    const number = (address: string) => address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
    const target = number(device.localip);
    const onLinkInterfacePresent = Object.values(os.networkInterfaces()).flat().some(item => item && !item.internal && item.family === "IPv4"
      && (number(item.address) & number(item.netmask)) === (target & number(item.netmask)));
    return { schemaVersion: 1, deviceId, model: device.model, localAddress: device.localip, onLinkInterfacePresent,
      connectionScope: "local-or-relay", observedAt: new Date().toISOString() };
  }

  /** Only an explicit video intent verifies a PIN, enters the page and provisions MISS keys. */
  private async videoSource(deviceId: string, region: string, password?: string, rememberPassword = false): Promise<VacuumVideoProvision> {
    const device = await this.cameraDevice(deviceId, region);
    // Official pv11cn plugin v61: verify existing PIN, then enter page '3'; never call set/forgot-password.
    const passwordTarget = this.passwordFile(deviceId, region);
    const savedBefore = fs.existsSync(passwordTarget) ? fs.readFileSync(passwordTarget, "utf8") : undefined;
    const suppliedPassword = password !== undefined;
    password ??= this.savedPassword(deviceId, region);
    if (password !== undefined) {
      if (!/^\d{4}$/.test(password)) failure("video_password_invalid", "请输入四位视频密码。", 400);
      const verified = await this.videoAction(deviceId, region, 7, password);
      const item = verified.out[0];
      const value = typeof item === "string" ? item : item?.piid === 7 ? item.value : undefined;
      if (value === "-1") failure("video_password_rejected", "视频密码不正确，请重新输入。", 422);
      if (verified.out.length !== 1 || value !== "0") failure("video_password_unconfirmed", "设备未确认视频密码，请在米家中核对。", 502);
      if (suppliedPassword && rememberPassword) {
        const currentSaved = fs.existsSync(passwordTarget) ? fs.readFileSync(passwordTarget, "utf8") : undefined;
        if (this.passwordFile(deviceId, region) !== passwordTarget || currentSaved !== savedBefore) failure("video_password_changed", "密码保存状态在校验期间发生变化，请重新连接。", 409);
        this.savePassword(deviceId, region, password);
      }
      password = undefined;
    }
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      await this.videoAction(deviceId, region, 4, "4");
    };
    try {
    await this.videoAction(deviceId, region, 4, "3");
    const pair = generateKeyPairSync("x25519");
    const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
    const privateKey = Buffer.from(pair.privateKey.export({ format: "jwk" }).d!, "base64url").toString("hex");
    const result = await this.call(region, "/v2/device/miss_get_vendor", { app_pubkey: publicKey, did: deviceId, support_vendors: "TUTK_CS2_MTP" });
    const vendor = result.result?.vendor, kind = ({ 1: "tutk", 4: "cs2" } as Record<number, string>)[vendor?.vendor];
    if (result.code !== 0 || !kind) failure("video_vendor_unsupported", `Mi Home did not offer a supported MISS vendor (code ${Number(result.code)}, vendor ${Number(vendor?.vendor)}).`, 422);
    if (!/^[0-9a-fA-F]{64}$/.test(result.result.public_key) || typeof result.result.sign !== "string" || !result.result.sign || result.result.sign.length > 4096) failure("response_invalid", "Mi Home returned invalid MISS session material.");
    const url = new URL(`xiaomi://${device.localip}`);
    for (const [key, value] of Object.entries({ client_public: publicKey, client_private: privateKey, device_public: result.result.public_key,
      sign: result.result.sign, vendor: kind, model: device.model, subtype: "3", audio: "0" })) url.searchParams.set(key, String(value));
    if (kind === "tutk") {
      const uid = vendor.vendor_params?.p2p_id;
      if (typeof uid !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(uid)) failure("response_invalid", "Mi Home returned an invalid MISS peer ID.");
      url.searchParams.set("uid", uid);
    }
    if (kind === "cs2" && vendor.vendor_params?.init_string) {
      let offer;
      try { offer = cs2RelayOffer(vendor.vendor_params.p2p_id, vendor.vendor_params.init_string); }
      catch { failure("video_relay_parameters_invalid", "小米返回的视频中继参数无法确认。", 502); }
      if (offer) {
        // Subnet membership does not prove native MISS reachability. Keep the
        // authenticated relay offer on every topology rather than discarding it.
        url.searchParams.set("cs2_peer", offer.peer);
        url.searchParams.set("cs2_servers", offer.servers.join(","));
      }
    }
    return { source: url.href, release };
    } catch (cause) {
      // An uncertain enter request also gets one exit attempt; never retry a PIN or start under another key.
      try { await release(); } catch { /* No raw device output or credential is exposed. */ }
      throw cause;
    }
  }

  private async videoAction(deviceId: string, region: string, aiid: 4 | 7, input: string): Promise<{ out: any[] }> {
    const result = await this.call(region, "/miotspec/action", { params: { did: deviceId, siid: 21, aiid, in: [input] } });
    const action = result.result;
    if (result.code !== 0 || !action || action.code !== 0) failure("video_action_rejected", "扫地机未受理视频会话操作。", 502);
    // The official page action declares no outputs. Cloud acknowledgements may omit that field.
    const emptyPageOutput = action.out == null || action.out === "" || Array.isArray(action.out) && action.out.length === 0;
    const invalid = action.did !== deviceId ? "device" : action.siid !== 21 ? "service" : action.aiid !== aiid ? "action"
      : aiid === 4 ? emptyPageOutput ? undefined : "output_count" : !Array.isArray(action.out) ? "output_type" : undefined;
    if (invalid) failure(`video_response_invalid_${aiid === 7 ? "verify" : input === "3" ? "enter" : "exit"}_${invalid}`, "扫地机的视频会话回执无法确认。", 502);
    return { out: aiid === 4 ? [] : action.out };
  }

  private resolve(): CloudSession | undefined {
    if (this.session) return this.session;
    if (!fs.existsSync(this.file)) return undefined;
    try {
      const file = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (file.schemaVersion !== 1 || file.protection !== this.protector.scheme) throw new Error("scheme");
      const session = JSON.parse(this.protector.unprotect(file.protectedSession)) as CloudSession;
      if (!/^\d{1,32}$/.test(session.userId) || !session.ssecurity || !session.serviceToken) throw new Error("session");
      this.session = session;
      return session;
    } catch { return failure("session_unavailable", "The cloud session cannot be opened by this local account.", 409); }
  }

  status(): unknown {
    return { schemaVersion: 1, connected: Boolean(this.resolve()), login: this.loginSnapshot(), mapDownload: "experimental", coordinateNavigation: false, audioInput: false, audioOutput: false };
  }

  private loginSnapshot(): unknown {
    if (!this.login) return undefined;
    return { sessionId: this.login.id, state: this.login.connected ? "connected" : Date.now() >= this.login.expiresAt ? "expired" : "waiting",
      expiresAt: new Date(this.login.expiresAt).toISOString(), ...(this.login.connected ? {} : { imageDataUrl: this.login.imageDataUrl }) };
  }

  private receiveCookies(response: Response, url: URL): void {
    for (const entry of response.headers.getSetCookie()) {
      const parts = entry.split(";").map(value => value.trim());
      const separator = parts[0]!.indexOf("=");
      if (separator < 1) continue;
      const name = parts[0]!.slice(0, separator), value = parts[0]!.slice(separator + 1);
      let domain = url.hostname, cookiePath = "/", hostOnly = true;
      for (const part of parts.slice(1)) {
        if (/^domain=/i.test(part)) { domain = part.slice(7).toLowerCase().replace(/^\./, ""); hostOnly = false; }
        if (/^path=/i.test(part)) cookiePath = part.slice(5);
      }
      if (!(url.hostname === domain || url.hostname.endsWith(`.${domain}`)) || ["com", "net"].includes(domain)) continue;
      this.cookies = this.cookies.filter(cookie => !(cookie.name === name && cookie.domain === domain && cookie.path === cookiePath));
      if (value && !parts.some(part => /^max-age=0$/i.test(part))) this.cookies.push({ name, value, domain, path: cookiePath, hostOnly, secure: true });
    }
  }

  private async accountRequest(input: string, timeoutMs = 12_000): Promise<Response> {
    let url = validatedCloudUrl(input);
    for (let redirects = 0; redirects < 5; redirects++) {
      const cookie = this.cookies.filter(c => (c.hostOnly ? c.domain === url.hostname : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`)) && url.pathname.startsWith(c.path))
        .map(c => `${c.name}=${c.value}`).join("; ");
      let response: Response;
      try { response = await this.fetchImpl(url, { headers: { "User-Agent": this.agent, Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
      catch { return failure("unreachable", "The Xiaomi account service is unreachable.", 504); }
      this.receiveCookies(response, url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) failure("response_invalid", "Xiaomi returned an invalid redirect.");
        url = validatedCloudUrl(new URL(location!, url).href);
      } else {
        if (!response.ok) failure("login_failed", "Xiaomi rejected the login request.");
        return response;
      }
    }
    return failure("redirect_limit", "Too many Xiaomi login redirects.");
  }

  begin(key: string): Promise<unknown> {
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(key)) return Promise.reject(new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_cloud_key_required", "Supply a stable login Idempotency-Key (16–160 characters)."));
    if (this.loginKey === key) {
      if (this.beginning) return this.beginning;
      if (this.login) return Promise.resolve(this.loginSnapshot());
      return Promise.reject(new XiaomiHomeManagerApiError(409, "xiaomi_vacuum_cloud_login_failed", "This login attempt failed; inspect status before explicitly starting a new attempt."));
    }
    if (this.beginning || this.login && !this.login.connected && Date.now() < this.login.expiresAt) return Promise.reject(new XiaomiHomeManagerApiError(409, "xiaomi_vacuum_cloud_login_active", "A login is already waiting; read its state instead of starting another."));
    const receipt = path.join(this.runtimeDir, "vacuum-cloud-logins", `${createHash("sha256").update(key).digest("hex")}.json`);
    if (fs.existsSync(receipt)) return Promise.reject(new XiaomiHomeManagerApiError(409, "xiaomi_vacuum_cloud_login_expired", "This login attempt is no longer in memory; inspect cloud status before explicitly starting a new login."));
    atomicWriteFileSync(receipt, JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }), { mode: 0o600 });
    this.loginKey = key;
    this.beginning = this.startLogin().finally(() => { this.beginning = undefined; });
    return this.beginning;
  }

  private async startLogin(): Promise<unknown> {
    this.cookies = [];
    const deviceId = randomBytes(4).toString("hex");
    for (const domain of ["mi.com", "xiaomi.com"]) for (const [name, value] of [["sdkVersion", "accountsdk-18.8.15"], ["deviceId", deviceId]]) {
      this.cookies.push({ name: name!, value: value!, domain, path: "/", secure: true, hostOnly: false });
    }
    const initial = accountJson(await boundedBytes(await this.accountRequest("https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true"), 1024 * 1024));
    if (!initial._sign) failure("response_invalid", "Xiaomi did not return a QR login challenge.");
    const params = new URLSearchParams({ _qrsize: "480", qs: initial.qs || "%3Fsid%3Dxiaomiio%26_json%3Dtrue", bizDeviceType: "", callback: initial.callback || "https://sts.api.io.mi.com/sts", _json: "true", theme: "", sid: "xiaomiio", needTheme: "false", showActiveX: "false", serviceParam: initial.location ? new URL(initial.location).searchParams.get("serviceParam") || "" : "", _local: "zh_CN", _sign: initial._sign, _dc: String(Date.now()) });
    const qr = accountJson(await boundedBytes(await this.accountRequest(`https://account.xiaomi.com/longPolling/loginUrl?${params}`), 1024 * 1024));
    if (!qr.lp || !qr.qr) failure("response_invalid", "Xiaomi did not return its QR image.");
    const pollUrl = validatedCloudUrl(qr.lp).href;
    const response = await this.accountRequest(qr.qr);
    const png = await boundedBytes(response, 1024 * 1024);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) failure("qr_invalid", "Xiaomi did not return a PNG QR image.");
    this.login = { id: randomUUID(), expiresAt: Date.now() + LOGIN_TTL, imageDataUrl: `data:image/png;base64,${png.toString("base64")}`, pollUrl, connected: false };
    return this.loginSnapshot();
  }

  async poll(sessionId: unknown): Promise<unknown> {
    const login = this.login;
    if (!login || sessionId !== login.id) failure("login_not_found", "Read the current login session first.", 404);
    if (login.connected || Date.now() >= login.expiresAt) return this.loginSnapshot();
    if (login.poll) return login.poll;
    login.poll = this.pollOnce(login).finally(() => { login.poll = undefined; });
    return login.poll;
  }

  private async pollOnce(login: Login): Promise<unknown> {
    let data: any;
    try { data = accountJson(await boundedBytes(await this.accountRequest(login.pollUrl!, Math.max(1, Math.min(25_000, login.expiresAt - Date.now()))), 1024 * 1024)); }
    catch (error) { if (error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_vacuum_cloud_unreachable") return this.loginSnapshot(); throw error; }
    if (data.code !== 0) return this.loginSnapshot();
    if (!/^\d{1,32}$/.test(String(data.userId)) || !data.ssecurity || !data.location) failure("response_invalid", "Xiaomi returned an incomplete session.");
    const response = await this.accountRequest(data.location);
    await response.body?.cancel();
    const token = this.cookies.find(c => c.name === "serviceToken" && (c.domain === "sts.api.io.mi.com" || c.domain === "api.io.mi.com" || c.domain === "io.mi.com" || c.domain === "mi.com"))?.value;
    if (!token) failure("login_failed", "Xiaomi did not finish the cloud login.");
    const session = { userId: String(data.userId), ssecurity: String(data.ssecurity), serviceToken: token };
    atomicWriteFileSync(this.file, JSON.stringify({ schemaVersion: 1, protection: this.protector.scheme, protectedSession: this.protector.protect(JSON.stringify(session)), verifiedAt: new Date().toISOString() }), { mode: 0o600 });
    this.session = session;
    login.connected = true; login.imageDataUrl = undefined; login.pollUrl = undefined; this.cookies = [];
    recordDataMutationAudit({ group: "xiaomi-home", event: "vacuum_cloud_connected", owner: "xiaomi-vacuum-cloud", action: "connect", target: { type: "connection", id: "vacuum-cloud" }, dataSource: { kind: "file", id: "vacuum-cloud-session.json" }, outcome: "committed" });
    return this.loginSnapshot();
  }

  private async call(region: string, endpoint: string, data: unknown): Promise<any> {
    if (!REGIONS.has(region)) failure("region_invalid", "Choose a supported Mi Home region.", 400);
    const session = this.resolve();
    if (!session) failure("login_required", "Connect Mi Home cloud with its QR login first.", 409);
    const url = new URL(`https://${region === "cn" ? "" : `${region}.`}api.io.mi.com/app${endpoint}`);
    const nonceBytes = Buffer.alloc(12); randomBytes(8).copy(nonceBytes); nonceBytes.writeUInt32BE(Math.floor(Date.now() / 60_000), 8);
    const nonce = nonceBytes.toString("base64");
    const signed = createHash("sha256").update(Buffer.concat([Buffer.from(session.ssecurity, "base64"), nonceBytes])).digest();
    const signedNonce = signed.toString("base64");
    const params: Record<string, string> = { data: JSON.stringify(data) };
    params.rc4_hash__ = cloudSignature(url, signedNonce, params);
    for (const [key, value] of Object.entries(params)) params[key] = cloudRc4(signed, Buffer.from(value)).toString("base64");
    params.signature = cloudSignature(url, signedNonce, params); params.ssecurity = session.ssecurity; params._nonce = nonce;
    url.search = new URLSearchParams(params).toString();
    let response: Response;
    try { response = await this.fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": this.agent, "Content-Type": "application/x-www-form-urlencoded", "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2", "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4", Cookie: `userId=${session.userId}; serviceToken=${session.serviceToken}; yetAnotherServiceToken=${session.serviceToken}; locale=zh_CN; channel=MI_APP_STORE` } }); }
    catch { return failure("unreachable", "The Mi Home cloud service is unreachable.", 504); }
    if ([401, 403].includes(response.status)) failure("login_required", "The Mi Home cloud session expired; reconnect with QR login.", 409);
    if (!response.ok) failure("request_failed", "Mi Home cloud rejected the request.");
    let result: any;
    try { result = JSON.parse(cloudRc4(signed, Buffer.from((await boundedBytes(response, MAX_BLOB)).toString("utf8"), "base64")).toString("utf8")); }
    catch (error) { if (error instanceof XiaomiHomeManagerApiError) throw error; return failure("response_invalid", "Mi Home cloud returned an invalid encrypted response."); }
    if ([3, -3, -6, 401].includes(result.code) && /auth|login|token/i.test(String(result.message || ""))) failure("login_required", "The Mi Home cloud session expired; reconnect with QR login.", 409);
    return result;
  }

  async devices(region = "cn"): Promise<VacuumCloudDevice[]> {
    const result = await this.call(region, "/home/device_list", { getVirtualModel: false, getHuamiDevices: 0 });
    if (result.code !== 0 || !Array.isArray(result.result?.list)) failure("request_failed", "Mi Home did not return a device list.");
    return result.result.list.filter((d: any) => /^\d{1,32}$/.test(String(d.did)) && /^[\w-]+\.vacuum\.[\w-]+$/.test(String(d.model)))
      .map((d: any) => ({ deviceId: String(d.did), model: String(d.model), name: String(d.name || d.model).slice(0, 160), online: d.isOnline === true }));
  }

  private async pluginMetadata(deviceId: string, region: string, sdkVersion: number) {
    if (!/^\d{1,32}$/.test(deviceId)) failure("query_invalid", "Supply a numeric deviceId.", 400);
    if (!Number.isInteger(sdkVersion) || sdkVersion < 10000 || sdkVersion > 10199) failure("query_invalid", "Supply a Mi Home SDK version from 10000 to 10199.", 400);
    const device = (await this.devices(region)).find(d => d.deviceId === deviceId);
    if (!device) failure("device_not_found", "This vacuum is not in the connected cloud account and region.", 404);
    const result = await this.call(region, "/v2/plugin/fetch_plugin", {
      latest_req: { api_version: sdkVersion, app_platform: "Android", region: region.toUpperCase(), package_type: "", plugins: [{ model: device.model }] },
      backup_req: { api_level: 101, app_platform: "phone", plugins: [{ model: device.model }] }
    });
    return { device, result };
  }

  async pluginInformation(deviceId: string, region = "cn", sdkVersion = 10112) {
    const {device, result} = await this.pluginMetadata(deviceId, region, sdkVersion);
    const redact = (items: any) => Array.isArray(items) ? items.filter(p => p.model === device.model).map(p => ({
      model: p.model, pluginId: p.plugin_id, packageId: p.package_id, version: p.version,
      apiLevel: p.api_level, type: p.type, hasDownload: Boolean(p.safe_url || p.download_url)
    })) : [];
    return { schemaVersion: 1, device, sdkVersion, code: Number(result.code),
      resultFields: Object.keys(result.result || {}), latestInfo: redact(result.result?.latest_info), backupInfo: redact(result.result?.backup_info) };
  }

  /** Official device package for static protocol inspection; never executes its contents. */
  async pluginPackage(deviceId: string, region = "cn", sdkVersion = 10112): Promise<unknown> {
    const {device, result} = await this.pluginMetadata(deviceId, region, sdkVersion);
    const entries = [...(Array.isArray(result.result?.latest_info) ? result.result.latest_info : []), ...(Array.isArray(result.result?.backup_info) ? result.result.backup_info : [])];
    const info = entries.find(p => p.model === device.model && (p.safe_url || p.download_url));
    if (result.code !== 0 || !info) failure("plugin_unavailable", `Mi Home did not return an official plugin package for this model (code ${Number(result.code)}, entries ${entries.length}).`, 404);
    let url = validatedCloudUrl(info.safe_url || info.download_url, true);
    const maximum = 64 * 1024 * 1024;
    for (let redirects = 0; redirects < 5; redirects++) {
      let response: Response;
      try { response = await this.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
      catch { return failure("unreachable", "The official plugin package download failed.", 504); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) failure("response_invalid", "The plugin download returned an invalid redirect.");
        url = validatedCloudUrl(new URL(location!, url).href, true); continue;
      }
      if (!response.ok) failure("plugin_unavailable", "Mi Home rejected the official plugin download.", 404);
      const raw = await boundedBytes(response, maximum);
      if (!raw.length) failure("plugin_unavailable", "Mi Home returned an empty plugin package.", 404);
      return { schemaVersion: 1, device, observedAt: new Date().toISOString(),
        pluginId: info.plugin_id, packageId: info.package_id, version: info.version,
        byteLength: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), packageBase64: raw.toString("base64") };
    }
    return failure("redirect_limit", "Too many plugin download redirects.");
  }

  /** Fixed device telemetry through the existing credential owner; never dispatches an action. */
  async telemetry(deviceId: string, region: string) {
    if (!/^\d{1,32}$/.test(deviceId)) failure("query_invalid", "Supply a numeric deviceId.", 400);
    const device = (await this.devices(region)).find(d => d.deviceId === deviceId);
    if (!device) failure("device_not_found", "This vacuum is not in the connected cloud account and region.", 404);
    const contract = vacuumTelemetryContracts[device.model];
    if (!contract) failure("telemetry_unsupported", "No verified telemetry properties exist for this model.", 422);
    const result = await this.call(region, "/v2/miotspec/prop/get", { datasource: 2, params: contract.map(property => ({did: deviceId, ...property})) });
    let telemetry;
    try { telemetry = parseVacuumTelemetry(result, deviceId, contract); }
    catch { return failure("response_invalid", "Mi Home returned invalid or rejected telemetry properties."); }
    return {schemaVersion: 1, device, observedAt: new Date().toISOString(), source: "device-rpc",
      ...telemetry, deviceUpdateTime: "unverified", coordinateNavigation: false};
  }

  /** Explicit property read through the official cloud API; a read timestamp is not pose freshness. */
  async position(deviceId: string, region: string) {
    if (!/^\d{1,32}$/.test(deviceId)) failure("query_invalid", "Supply a numeric deviceId.", 400);
    const device = (await this.devices(region)).find(d => d.deviceId === deviceId);
    if (!device) failure("device_not_found", "This vacuum is not in the connected cloud account and region.", 404);
    const contract = vacuumPositionContracts[device.model];
    if (!contract) failure("position_unsupported", "No verified position property exists for this model.", 422);
    // SDK datasource=2 reads the device via RPC; datasource=1 may return a stale cloud cache.
    const result = await this.call(region, "/v2/miotspec/prop/get", { datasource: 2, params: [{ did: deviceId, ...contract }] });
    const property = Array.isArray(result.result) && result.result.length === 1 ? result.result[0] : undefined;
    if (result.code !== 0 || property?.code !== 0) failure("position_rejected", "The provider rejected the read-only position query.");
    if (property.did !== deviceId || property.siid !== contract.siid || property.piid !== contract.piid) failure("response_invalid", "Mi Home returned a mismatched position property.");
    let point;
    try { point = parseVacuumPosition(property.value); }
    catch (error) { return failure("response_invalid", `Mi Home returned an invalid bounded position payload (${error instanceof VacuumPositionParseError ? error.reason : "parse_failure"}).`); }
    return { schemaVersion: 1, device, observedAt: new Date().toISOString(), source: "vacuum-position-property",
      state: point ? "sample" : "unavailable", ...(point ? { position: point } : {}),
      poseFreshness: "unverified", coordinateUnit: "unverified", coordinateNavigation: false };
  }

  /** Queries the official read-only action; does not start or alter a robot task. */
  async trajectory(deviceId: string, region: string, poseId: string) {
    if (!/^\d{1,32}$/.test(deviceId) || !/^\d{1,10}$/.test(poseId) || Number(poseId) > 2147483647) failure("query_invalid", "Supply a numeric deviceId and poseId from 0 to 2147483647.", 400);
    const device = (await this.devices(region)).find(d => d.deviceId === deviceId);
    if (!device) failure("device_not_found", "This vacuum is not in the connected cloud account and region.", 404);
    const contract = vacuumTrajectoryContracts[device.model];
    if (!contract) failure("trajectory_unsupported", "No verified read-only trajectory contract exists for this model.", 422);
    const afterPoseId = Number(poseId);
    const result = await this.call(region, "/miotspec/action", { params: {
      did: deviceId, siid: contract.siid, aiid: contract.aiid, in: [JSON.stringify({ pose_id: afterPoseId })]
    } });
    const action = result.result;
    if (result.code !== 0 || !action || action.code !== 0) failure("trajectory_rejected", `The device rejected the read-only trajectory query (code ${Number(action?.code ?? result.code)}).`, 502);
    if (action.did !== deviceId || action.siid !== contract.siid || action.aiid !== contract.aiid || !Array.isArray(action.out) || action.out.length !== 1) failure("response_invalid", "Mi Home returned a mismatched trajectory response.");
    const item = action.out[0];
    const output = typeof item === "string" ? item : item && item.piid === contract.outputPiid ? item.value : undefined;
    let points;
    try { points = parseVacuumTrajectory(output); }
    catch (error) { return failure("response_invalid", `Mi Home returned an invalid bounded trajectory payload (${error instanceof VacuumTrajectoryParseError ? error.reason : "parse_failure"}; bytes ${typeof output === "string" ? Buffer.byteLength(output) : 0}).`); }
    return { schemaVersion: 1, device, observedAt: new Date().toISOString(), source: "get-vacuum-route",
      afterPoseId, nextPoseId: Math.max(afterPoseId, points.at(-1)?.poseId ?? afterPoseId), points,
      latestReturnedPoint: points.at(-1), newPointCount: points.filter(p => p.poseId > afterPoseId).length,
      poseFreshness: "unverified", coordinateNavigation: false };
  }

  /** Shared, on-demand map/trajectory feedback. No polling or movement owner. */
  async feedback(deviceId: string, region: string, slot: string, previousScope = "", poseId = "") {
    if ((previousScope || poseId) && (!/^[a-f0-9]{64}$/.test(previousScope) ||
      !/^\d{1,10}$/.test(poseId) || Number(poseId) > 2147483647)) {
      failure("query_invalid", "Supply both feedback scope and poseId, or omit both to start a read.", 400);
    }
    const before = await this.map(deviceId, region, slot);
    const account = this.resolve()!.userId;
    if (!vacuumTrajectoryContracts[before.device.model]) return {schemaVersion: 1, map: before, feedback: {
      state: "trajectory_unsupported", reset: true, newPointCount: 0,
      observedAt: before.observedAt, poseFreshness: "unverified", coordinateNavigation: false}};
    const identity = vacuumFeedbackIdentity(before, region, account);
    if (!identity) return {schemaVersion: 1, map: before, feedback: {
      state: "map_identity_unavailable", reset: true, newPointCount: 0,
      observedAt: before.observedAt, poseFreshness: "unverified", coordinateNavigation: false}};
    const prepared = prepareVacuumFeedback(identity, previousScope, poseId ? Number(poseId) : 0);
    let trajectory;
    try { trajectory = await this.trajectory(deviceId, region, String(prepared.queryPoseId)); }
    catch (error) {
      if (!(error instanceof XiaomiHomeManagerApiError) || error.status < 500) throw error;
      if (this.resolve()?.userId !== account) failure("account_changed", "The cloud account changed during the feedback read.", 409);
      return {schemaVersion: 1, map: before, feedback: {
        state: "trajectory_unavailable", failureReason: error.code, reset: true, newPointCount: 0,
        observedAt: new Date().toISOString(), poseFreshness: "unverified", coordinateNavigation: false}};
    }
    const after = await this.map(deviceId, region, slot);
    if (this.resolve()?.userId !== account) failure("account_changed", "The cloud account changed during the feedback read.", 409);
    return {schemaVersion: 1, map: after, feedback: consumeVacuumFeedback(prepared,
      vacuumFeedbackIdentity(after, region, account), trajectory.points, trajectory.observedAt)};
  }

  async path(deviceId: string, region: string, slot: string, mapHash: string, targetX: string, targetY: string, clearanceMm = "250") {
    const coordinate = /^-?\d{1,10}(?:\.\d{1,3})?$/;
    if (!/^[a-f0-9]{64}$/.test(mapHash) || !coordinate.test(targetX) || !coordinate.test(targetY) || !/^\d{3}$/.test(clearanceMm)) failure("query_invalid", "Supply the displayed map SHA-256, finite millimeter target coordinates and an integer clearance radius.", 400);
    const data = await this.map(deviceId, region, slot);
    if (data.sha256 !== mapHash) failure("map_changed", "The cloud map changed; refresh the displayed map before planning.", 409);
    if (!data.decoded) failure("map_decode_required", "The current cloud map could not be decoded.", 422);
    return { ...planVacuumMapPath(data, { x: Number(targetX), y: Number(targetY) }, Number(clearanceMm)),
      device: data.device, mapSha256: data.sha256, observedAt: data.observedAt };
  }

  async map(deviceId: string, region = "cn", slot = "0"): Promise<CloudMapResult> {
    if (!/^\d{1,32}$/.test(deviceId) || !/^[0-9]{1,2}$/.test(slot)) failure("query_invalid", "Supply a numeric deviceId and object slot (0–99).", 400);
    const key = JSON.stringify([region, deviceId, slot]);
    const current = this.mapReads.get(key);
    if (current) return current;
    const read = this.readMap(deviceId, region, slot).finally(() => { this.mapReads.delete(key); });
    this.mapReads.set(key, read);
    return read;
  }

  private async readMap(deviceId: string, region: string, slot: string): Promise<CloudMapResult> {
    const device = (await this.devices(region)).find(d => d.deviceId === deviceId);
    if (!device) failure("device_not_found", "This vacuum is not in the connected cloud account and region.", 404);
    const session = this.resolve()!;
    let downloadUrl: string | undefined;
    for (const endpoint of ["get_interim_file_url_pro", "get_interim_file_url"]) {
      const result = await this.call(region, `/v2/home/${endpoint}`, { obj_name: `${session.userId}/${deviceId}/${slot}` });
      if (typeof result.result?.url === "string") { downloadUrl = result.result.url; break; }
    }
    if (!downloadUrl) failure("map_unavailable", "Mi Home did not return a map file URL for this device and slot.", 404);
    let url = validatedCloudUrl(downloadUrl!, true);
    for (let redirects = 0; redirects < 5; redirects++) {
      let response: Response;
      try { response = await this.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
      catch { return failure("unreachable", "The map file download failed.", 504); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) failure("response_invalid", "The map download returned an invalid redirect.");
        url = validatedCloudUrl(new URL(location!, url).href, true); continue;
      }
      if (!response.ok) failure("map_unavailable", "Mi Home rejected the map file download.", 404);
      const raw = await boundedBytes(response, MAX_BLOB);
      if (!raw.length) failure("map_unavailable", "Mi Home returned an empty map file.", 404);
      let decoded;
      try { decoded = decodeXiaomiVacuumMap(raw, device.model, device.deviceId); }
      catch { decoded = { decoded: false as const, decodeState: "unsupported_or_invalid", coordinateNavigation: false as const }; }
      return { schemaVersion: 1, device, slot, observedAt: new Date().toISOString(), byteLength: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), blobBase64: raw.toString("base64"), ...decoded };
    }
    return failure("redirect_limit", "Too many map download redirects.");
  }
}

import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import type { ApiOperationDefinition, ApiUpgradeDefinition, ApiUpgradeInput } from "@rabiroute/plugin-sdk";
import type { HtmlShareTransports, HtmlShareChannel, HtmlShareRtc, HtmlShareSocketServer } from "./shareTransports.js";

type Share = { id: string; key: string; name: string; createdAt: string };
type Relay = { enabled: boolean; url: string; token: string; deviceId: string; deviceGuid: string };
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

async function snapshotHtml(file: string): Promise<string> {
  const types: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
  const resource = async (reference: string, owner: string, parents: Set<string>): Promise<string> => {
    if (/^(?:https?:|data:|blob:|#|\/\/)/i.test(reference)) return reference;
    const value = reference.replace(/[?#].*$/, "");
    const resolved = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(path.dirname(owner), decodeURIComponent(value));
    if (parents.has(resolved)) throw new Error(`HTML resource cycle: ${path.basename(resolved)}`);
    const extension = path.extname(resolved).toLowerCase(), type = types[extension];
    if (!type) return reference;
    let content = await fs.readFile(resolved);
    if (extension === ".css") {
      content = Buffer.from(await cssResources(content.toString("utf8"), resolved, new Set([...parents, resolved])));
    } else if (extension === ".js" || extension === ".mjs") {
      let script = content.toString("utf8");
      for (const match of [...script.matchAll(/(\b(?:from\s*|import\s*(?:\(\s*)?))(["'])([^"']+)\2/g)].reverse()) {
        const value = await resource(match[3], resolved, new Set([...parents, resolved]));
        script = script.slice(0, match.index) + match[1] + match[2] + value + match[2] + script.slice(match.index! + match[0].length);
      }
      content = Buffer.from(script);
    }
    return `data:${type};base64,${content.toString("base64")}`;
  };
  const cssResources = async (css: string, owner: string, parents: Set<string>): Promise<string> => {
    for (const match of [...css.matchAll(/@import\s+(["'])(.*?)\1/g)].reverse()) {
      css = css.slice(0, match.index) + `@import url('${await resource(match[2], owner, parents)}')` + css.slice(match.index! + match[0].length);
    }
    for (const match of [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)].reverse()) {
      css = css.slice(0, match.index) + `url('${await resource(match[2].trim(), owner, parents)}')` + css.slice(match.index! + match[0].length);
    }
    return css;
  };
  let html = await fs.readFile(file, "utf8");
  for (const match of [...html.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi)].reverse()) {
    html = html.slice(0, match.index) + match[1] + await cssResources(match[2], file, new Set([file])) + match[3] + html.slice(match.index! + match[0].length);
  }
  for (const match of [...html.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gi)].reverse()) {
    const css = await cssResources(match[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'"), file, new Set([file]));
    html = html.slice(0, match.index) + `style="${css.replace(/"/g, "&quot;")}"` + html.slice(match.index! + match[0].length);
  }
  const matches = [...html.matchAll(/<(?:img|script|link|source)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)];
  for (const match of matches.reverse()) {
    const value = await resource((match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&"), file, new Set([file]));
    const tag = match[0].replace(/(\b(?:src|href)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_original, attribute) => `${attribute}"${value.replace(/"/g, "&quot;")}"`);
    html = html.slice(0, match.index) + tag + html.slice(match.index! + match[0].length);
  }
  return html;
}

/** The PC owns immutable snapshots. Relay receives routing metadata and opaque encrypted frames only. */
export class CompletionHtmlShares {
  readonly directory: string;
  private readonly rtc: HtmlShareRtc;
  private readonly sockets: HtmlShareSocketServer;
  private readonly channels = new Set<HtmlShareChannel>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly publishing = new Map<string, Promise<string>>();
  private readonly controller = new AbortController();
  private stopped = false;
  private retirement?: Promise<void>;
  constructor(storageDirectory: string, private readonly relay: () => Relay, private readonly transports: HtmlShareTransports) {
    this.directory = storageDirectory;
    this.rtc = transports.createRtc();
    this.sockets = transports.createWebSocketServer({ maxPayload: 65536 });
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }
  publish(file: string, deliveryId: string): Promise<string> {
    if (this.stopped) return Promise.reject(new Error("HTML share owner is stopping."));
    const key = createHash("sha256").update(deliveryId).digest("hex");
    const active = this.publishing.get(key); if (active) return active;
    const work = this.track(this.publishCurrent(file, key)).finally(() => this.publishing.delete(key));
    this.publishing.set(key, work); return work;
  }
  private async publishCurrent(file: string, intent: string): Promise<string> {
    const relay = this.relay();
    if (!relay.enabled || !relay.url || !relay.token) throw new Error("HTML 分享需要已配置并在线的 RabiLink 连接。");
    const intents = path.join(this.directory, "intents"); await fs.mkdir(intents, { recursive: true });
    const index = path.join(intents, intent + ".json");
    let share: Share;
    try { share = JSON.parse(await fs.readFile(index, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!(await fs.stat(file)).isFile()) throw new Error("HTML attachment is not a regular file.");
      share = { id: randomUUID(), key: randomBytes(32).toString("base64url"), name: path.basename(file), createdAt: new Date().toISOString() };
      const folder = path.join(this.directory, share.id); await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "index.html"), await snapshotHtml(file));
      await fs.writeFile(path.join(folder, "share.json"), JSON.stringify(share));
      // The original delivery id keeps the same UUID/key after a retry or process restart.
      await fs.writeFile(index, JSON.stringify(share), { flag: "wx" });
      recordDataMutationAudit({ group: "plugin.html-shares", event: "html_share_snapshot_prepared", owner: "CompletionHtmlShares", action: "create", target: { type: "html-share-intent", id: intent }, dataSource: { kind: "file", id: index }, outcome: "committed" });
    }
    const url = relay.url.replace(/\/+$/, "");
    const response = await fetch(url + "/worker/html-shares", {
      method: "POST", headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
      body: JSON.stringify({ id: share.id, deviceId: relay.deviceId, deviceGuid: relay.deviceGuid, transports: this.transports.priority }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(getTimeoutMs("htmlShare.publish", 15000))])
    });
    if (!response.ok) throw new Error(`HTML 分享登记失败 (${response.status})；请检查 RabiLink 服务版本和连接。`);
    const registration = await response.json() as { id?: string };
    if (registration.id !== share.id) throw new Error("HTML share registration returned another ID.");
    // Fragment is never sent in HTTP requests, access logs or Relay handshake metadata.
    return `${url}/share/${share.id}#${share.key}`;
  }
  private async readShare(id: string): Promise<Share> {
    if (!validId(id)) throw new Error("Invalid HTML share ID.");
    const share = JSON.parse(await fs.readFile(path.join(this.directory, id, "share.json"), "utf8")) as Share;
    if (share.id !== id) throw new Error("HTML share identity mismatch.");
    return share;
  }
  /** Each request returns one AEAD frame; pull-based delivery reuses channel backpressure without buffering a whole file. */
  private async serve(id: string, channel: HtmlShareChannel): Promise<void> {
    if (this.stopped) { await channel.close(); return; }
    this.channels.add(channel);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};
    let flight = Promise.resolve();
    let closed = false;
    const markClosed = () => { closed = true; };
    channel.on("close", markClosed);
    try {
      const share = await this.readShare(id);
      if (closed || this.stopped) return;
      file = await fs.open(path.join(this.directory, id, "index.html"), "r");
      const bytes = (await file.stat()).size;
      if (closed || this.stopped) return;
      await channel.send(Buffer.from(JSON.stringify({ bytes, name: share.name })));
      if (closed || this.stopped) return;
      let offset = 0, sequence = 0;
      await new Promise<void>((resolve, reject) => {
        const close = () => resolve();
        const fail = (error: unknown) => reject(error);
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error("HTML share read timed out.")), getTimeoutMs("htmlShare.readIdle", 30000)); timer.unref(); };
        const onData = (data: Buffer) => {
          flight = flight.then(async () => {
            arm();
            if (data.toString() === "done" && offset === bytes) { resolve(); return; }
            if (data.toString() !== "next") throw new Error("Invalid HTML share read request.");
            const buffer = Buffer.alloc(Math.min(12 * 1024, bytes - offset));
            const read = await file!.read(buffer, 0, buffer.length, offset);
            if (read.bytesRead !== buffer.length) throw new Error("HTML snapshot changed while reading.");
            const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(share.key, "base64url"), nonce);
            const aad = Buffer.from(`${id}:${sequence++}:${offset}:${bytes}`); cipher.setAAD(aad);
            const encrypted = Buffer.concat([cipher.update(buffer), cipher.final(), cipher.getAuthTag()]);
            await channel.send(Buffer.from(JSON.stringify({ nonce: nonce.toString("base64"), data: encrypted.toString("base64"), aad: aad.toString() })));
            offset += read.bytesRead;
            // SCTP send only enqueues bytes. Keep the owner alive until the viewer confirms receipt.
          }); void flight.catch(fail);
        };
        arm(); channel.on("data", onData); channel.once("close", close);
        this.controller.signal.addEventListener("abort", close, { once: true });
        // Cleanup belongs to this accepted read, including an in-flight file read.
        cleanup = () => { channel.off("data", onData); channel.off("close", close); this.controller.signal.removeEventListener("abort", close); };
      });
    } finally { channel.off("close", markClosed); cleanup(); clearTimeout(timer); await flight.catch(() => {}); await file?.close(); await channel.close(); this.channels.delete(channel); }
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, admission?: ApiUpgradeInput): boolean {
    const match = /^\/html-shares\/([a-f0-9-]+)\/socket$/.exec(new URL(request.url || "/", "http://local").pathname);
    if (!match || !validId(match[1])) return false;
    if (this.stopped) { socket.destroy(); return true; }
    const headers = (values: string[], incoming: IncomingMessage) => {
      if (!admission || incoming !== request) return;
      admission.assertCurrent();
      const result: Record<string, string> = {};
      for (const header of values) { const colon = header.indexOf(":"); if (colon > 0) result[header.slice(0, colon).toLowerCase()] = header.slice(colon + 1).trim(); }
      admission.prepareHandshake(result);
    };
    this.sockets.on("headers", headers);
    try {
      this.sockets.handleUpgrade(request, socket, head, ws => {
        const channel = this.transports.websocketChannel(ws);
        if (admission) {
          admission.assertCurrent();
          const closed = new Promise<void>(resolve => channel.once("close", resolve));
          admission.accept({ closed, close: () => channel.close() });
          const send = channel.send.bind(channel);
          channel.send = async bytes => { admission.validateOutgoing(bytes, bytes.length); await send(bytes); };
          channel.on("data", (bytes: Buffer) => { try { admission.validateIncoming(bytes, bytes.length); } catch { socket.destroy(); } });
        }
        this.track(this.serve(match[1], channel)).catch(() => channel.close());
      });
    } finally { this.sockets.off("headers", headers); }
    return true;
  }
  offer(id: string, input: { kind?: string; sdp?: string; room?: string }): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("HTML share owner is stopping."));
    return this.track(this.offerCurrent(id, input));
  }
  private async offerCurrent(id: string, input: { kind?: string; sdp?: string; room?: string }): Promise<unknown> {
    if (this.stopped) throw new Error("HTML share owner is stopping.");
    await this.readShare(id);
    if (input.kind === "p2p") return this.rtc.offer(input.sdp, channel => { void this.track(this.serve(id, channel)).catch(() => channel.close()); });
    if (input.kind !== "relay" || !input.room || !validId(input.room)) throw new Error("Invalid HTML share transport offer.");
    const relay = this.relay(), url = new URL(relay.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/share/${id}/socket`;
    url.search = new URLSearchParams({ room: input.room, side: "pc" }).toString();
    const channel = await this.transports.connectWebsocket(url.toString(), { "x-rabilink-token": relay.token },
      AbortSignal.any([this.controller.signal, AbortSignal.timeout(getTimeoutMs("peer.relayConnect", 5000))]));
    void this.track(this.serve(id, channel)).catch(() => channel.close()); return { ok: true };
  }
  upgrades(): ApiUpgradeDefinition[] {
    return [{ contract: {
      operationId: "manager.html-shares.read", contractVersion: "1.0.0", method: "GET", pathTemplate: "/html-shares/:id/socket",
      description: "Read one explicitly published encrypted HTML snapshot over the existing shared listener.", exposure: "public", transport: "websocket",
      request: { path: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
      websocket: { protocol: "rabiroute.html-share.v1", framing: "bytes", maxMessageBytes: 65536, maxBufferedBytes: 65536,
        authentication: "The published GUID selects one immutable snapshot; only the complete fragment key can decrypt its bytes.",
        completion: "The original accepted channel must close before the plugin activation lease is released.",
        cancellation: "Plugin retirement closes its own channels; no business request is retried." },
      responses: { "101": { mediaType: "application/octet-stream", schema: false, headers: { type: "object", required: ["upgrade", "connection", "sec-websocket-accept"], properties: { upgrade: { const: "websocket" }, connection: { const: "Upgrade" }, "sec-websocket-accept": { type: "string" } }, additionalProperties: true } }, "404": { mediaType: "application/json", schema: true } },
      effects: { mode: "immutable-snapshot-read", description: "Read encrypted bytes from the current plugin-owned cache; no Manager or arbitrary file route." },
      recovery: { strategy: "new-read-connection", description: "A viewer may reconnect to the same immutable GUID; this never replays a business send." },
      validators: [{ id: "html-share-guid", description: "The exact published GUID is resolved by the original cache owner." }]
    }, handler: input => {
      if (!this.upgrade(input.request, input.socket, Buffer.from(input.head), input)) input.reject(404, { error: "Unknown HTML share path." });
    } }];
  }
  operations(): ApiOperationDefinition[] {
    return [{ contract: {
      operationId: "manager.html-shares.offer", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/html-shares/:id/offer",
      description: "Accept transport-only signaling for one published HTML snapshot. Does not expose Manager APIs or return HTML through Relay HTTP.", exposure: "public", transport: "http",
      request: { path: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, query: { type: "object" }, headers: { type: "object" },
        body: { kind: "json", maxBytes: 65536, schema: { type: "object", properties: { kind: { enum: ["p2p", "relay"] }, sdp: { type: "string" }, room: { type: "string" } }, required: ["kind"], additionalProperties: false } } },
      responses: { "200": { mediaType: "application/json", schema: true } },
      effects: { mode: "transport-control", description: "Creates a capability-scoped connection. PC cache and key stay local; data frames are encrypted." },
      recovery: { strategy: "new-read-connection", description: "Repeat a read handshake after a failed transport; no business messages or writes are replayed." },
      validators: [{ id: "html-share-owner", description: "Existing connection admission plus exact published GUID. This endpoint cannot select a file or a Manager operation." }]
    }, handler: async input => ({ status: 200, body: await this.offer(input.path.id, input.body as { kind?: string; sdp?: string; room?: string }) }) }];
  }
  stop(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.stopped = true; this.controller.abort();
    return this.retirement = (async () => {
      const closing = await Promise.allSettled([...this.channels].map(channel => channel.close()).concat([this.rtc.stop()]));
      await Promise.allSettled([...this.pending]);
      await new Promise<void>((resolve, reject) => this.sockets.close(error => error ? reject(error) : resolve()));
      const failed = closing.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
  }
}

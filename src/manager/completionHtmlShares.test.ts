import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import test from "node:test";
import { CompletionHtmlShares } from "../plugins/io.rabiroute.manager.html-shares/src/manager/completionHtmlShares.js";
import type { HtmlShareTransports, HtmlShareChannel } from "../plugins/io.rabiroute.manager.html-shares/src/manager/shareTransports.js";
import { PEER_TRANSPORT_PRIORITY } from "../shared/peerTunnelContract.js";
import { nativeHttpTestStreamFetch } from "./nativeHttpTestClient.js";
import { websocketChannel, connectWebsocket } from "../peerTunnel/channel.js";
import { TunnelRtc } from "../peerTunnel/rtc.js";
import type { TunnelChannel } from "../peerTunnel/channel.js";
import { spawn } from "node:child_process";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";
import { createHtmlShareRelay } from "../plugins/io.rabiroute.manager.html-shares/relay/rabilink-html-shares.mjs";
import { EventEmitter } from "node:events";

function ownedChannel(channel: TunnelChannel): HtmlShareChannel {
  const close = channel.close.bind(channel);
  return Object.assign(channel, { close: async () => { await close(); } });
}
function transports(): HtmlShareTransports {
  return {
    priority: PEER_TRANSPORT_PRIORITY,
    createRtc() { const rtc = new TunnelRtc([]); return { offer: (sdp, accept) => rtc.offer(sdp, channel => accept(ownedChannel(channel))), stop: () => rtc.stop() }; },
    createWebSocketServer: options => new WebSocketServer({ noServer: true, maxPayload: options.maxPayload }),
    websocketChannel: socket => ownedChannel(websocketChannel(socket as WebSocket)),
    connectWebsocket: async (url, headers, signal) => ownedChannel(await connectWebsocket(url, headers, signal))
  };
}

function receive(channel: TunnelChannel): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  let complete = false;
  return new Promise((resolve, reject) => {
    channel.on("data", data => { frames.push(data); if (frames.length === 1) void channel.send(Buffer.from("next")).catch(reject); else {
      const header = JSON.parse(frames[0].toString()), packet = JSON.parse(data.toString()), [, , offset] = packet.aad.split(":");
      if (Number(offset) + Buffer.from(packet.data, "base64").length - 16 === header.bytes) { complete = true; void channel.send(Buffer.from("done")).then(() => resolve(frames), reject); }
      else void channel.send(Buffer.from("next")).catch(reject);
    } });
    channel.once("close", () => { if (!complete) reject(new Error("Share closed before complete document.")); });
  });
}
function decrypt(frames: Buffer[], key: string): string {
  return Buffer.concat(frames.slice(1).map(frame => { const p = JSON.parse(frame.toString()), bytes = Buffer.from(p.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), Buffer.from(p.nonce, "base64"));
    decipher.setAAD(Buffer.from(p.aad)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
  })).toString();
}
test("HTML shares persist PC snapshots/keys, use the existing priority, and deliver encrypted content over native P2P and Relay", { timeout: 60000 }, async t => {
  t.mock.method(globalThis, "fetch", nativeHttpTestStreamFetch);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-html-share-"));
  let store: CompletionHtmlShares;
  const relay = createHtmlShareRelay({ directory: path.join(root, "relay"),
    authorize: (req: http.IncomingMessage) => req.headers["x-rabilink-token"] === "test-application" ? { ok: true, app: { id: "app" } } : { ok: false },
    target: (app: string, device: string) => app === "app" && device === "pc" ? { app: { id: "app" }, worker: { id: "pc", peerUrls: ["http://127.0.0.1:9"] } } : undefined,
    signal: (_req: unknown, _target: unknown, id: string, offer: object) => store.offer(id, offer) });
  const server = http.createServer((req, res) => { void relay.handle(req, new URL(req.url!, "http://test"), res).then((handled: boolean) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  server.on("upgrade", (req, socket, head) => { if (!relay.upgrade(req, socket, head)) store.upgrade(req, socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`, config = () => ({ enabled: true, url, token: "test-application", deviceId: "pc", deviceGuid: "pc" });
  store = new CompletionHtmlShares(root, config, transports());
  const rtc = new TunnelRtc([]);
  try {
    const file = path.join(root, "report.html"), css = path.join(root, "report.css");
    await fs.writeFile(css, "h1{color:red}");
    await fs.writeFile(path.join(root, "bg.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.writeFile(path.join(root, "import.css"), "body{font-size:20px}");
    await fs.writeFile(path.join(root, "dependency.mjs"), "export const title = 'module dependency';");
    await fs.writeFile(path.join(root, "app.mjs"), "import { title } from './dependency.mjs'; document.title = title;");
    await fs.writeFile(css, '@import "import.css";h1{color:red;background:url(bg.svg)}');
    await fs.writeFile(file, '<!doctype html><script type="module" src="./app.mjs"></script><link href=report.css rel="stylesheet"><style>body{background:url("./bg.svg")}</style><h1 style="background:url(./bg.svg)">缓存内容</h1>' + "正文".repeat(15000));
    const link = new URL(await store.publish(file, "original-delivery")), id = link.pathname.split("/").at(-1)!, key = link.hash.slice(1);
    await fs.writeFile(file, "changed"); assert.equal(await store.publish(file, "original-delivery"), link.toString());
    const connection = await (await fetch(url + link.pathname + "/connection")).json() as any;
    assert.deepEqual(connection.transports, PEER_TRANSPORT_PRIORITY);
    assert.deepEqual(connection.peerUrls, ["http://127.0.0.1:9"]);
    const page = await (await fetch(url + link.pathname)).text(); assert.doesNotMatch(page, /缓存内容|test-application/);
    const index = await fs.readFile(path.join(root, "relay/html-share-directory", id + ".json"), "utf8"); assert.doesNotMatch(index, /缓存内容|test-application|"key"/);
    const { websocketChannel } = await import("../peerTunnel/channel.js");
    const localSocket = new WebSocket(url.replace("http", "ws") + `/html-shares/${id}/socket`);
    const localFrames = receive(websocketChannel(localSocket));
    const localHtml = decrypt(await localFrames, key);
    assert.match(localHtml, /缓存内容/);
    let capture: Promise<Buffer[]> | undefined;
    const channel = await rtc.connect(async offer => {
      const response = await fetch(url + link.pathname + "/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "p2p", ...offer }) });
      assert.equal(response.status, 200); return await response.json() as { sdp: string };
    }, AbortSignal.timeout(20000));
    capture = receive(channel); const p2p = await capture; const html = decrypt(p2p, key);
    assert.match(html, /缓存内容/); assert.match(html, /data:text\/css;base64/); assert.doesNotMatch(html, /changed/);
    assert.match(html, /data:image\/svg\+xml;base64/); assert.doesNotMatch(html, /(?:url\(["']?)\.\/bg\.svg/);
    assert.match(html, /data:text\/javascript;base64/); assert.doesNotMatch(html, /src="\.\/app\.mjs"/);
    await channel.close();
    const { randomUUID } = await import("node:crypto");
    const socket = new WebSocket(url.replace("http", "ws") + link.pathname + `/socket?side=viewer&room=${randomUUID()}`);
    const frames = receive(websocketChannel(socket)); void frames.catch(() => {});
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const room = new URL(socket.url).searchParams.get("room");
    const answer = await fetch(url + link.pathname + "/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "relay", room }) });
    assert.equal(answer.status, 200); assert.equal(decrypt(await frames, key), html); assert.equal(html, localHtml);
    await assert.rejects(store.offer("../secret", { kind: "p2p" }), /Invalid HTML share ID/);
    const foreign = await fetch(url + "/worker/html-shares", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }); assert.equal(foreign.status, 401);
    // Reproduce stop during the first asynchronous header send, before the read loop is attached.
    const paused = new CompletionHtmlShares(root, config, transports());
    let release!: () => void, header!: () => void;
    const headerStarted = new Promise<void>(resolve => header = resolve);
    const channelFixture = new EventEmitter() as TunnelChannel;
    channelFixture.send = () => { header(); return new Promise<void>(resolve => release = resolve); };
    channelFixture.close = async () => { channelFixture.emit("close"); };
    const internal = paused as unknown as { serve(id: string, channel: TunnelChannel): Promise<void>; track<T>(work: Promise<T>): Promise<T> };
    const pending = internal.track(internal.serve(id, channelFixture)); await headerStarted;
    const stopping = paused.stop(); release();
    await Promise.race([Promise.all([pending, stopping]), new Promise((_, reject) => setTimeout(() => reject(new Error("Stopping a header send leaked the read loop.")), 500))]);
  } finally { await rtc.stop(); await store.stop(); relay.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});

test("published HTML signaling crosses the real Relay worker queue and registered PC operation", { timeout: 45000 }, async t => {
  t.mock.method(globalThis, "fetch", nativeHttpTestStreamFetch);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-html-queue-"));
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], { windowsHide: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", RABILINK_RELAY_DATA_DIR: path.join(root, "relay") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stderr.on("data", data => output += data);
  const endpoint = await new Promise<{ port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay startup timed out: " + output)), 10000);
    child.stdout.on("data", data => { output += data; const match = /RABILINK_RELAY_READY:(\{[^\n]+\})/.exec(output); if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Relay exited: " + output)); });
  });
  const relayUrl = `http://127.0.0.1:${endpoint.port}`;
  const account = await fetch(relayUrl + "/manage/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "share-test", password: "test-password-long" }) });
  assert.equal(account.status, 200); const cookie = account.headers.get("set-cookie")!.split(";")[0];
  const application = await fetch(relayUrl + "/manage/api/apps", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "HTML transport test" }) });
  assert.equal(application.status, 200); const token = ((await application.json()) as any).app.token;
  const store = new CompletionHtmlShares(root, () => ({ enabled: true, url: relayUrl, token, deviceId: "share-pc", deviceGuid: "share-pc" }), transports());
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("html-share-test", store.operations());
  const pc = http.createServer((req, res) => {
    if (req.url === "/api/events" || req.url === "/api/speech/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: ready\ndata: {}\n\n"); return; }
    if (!registry.handle(req, new URL(req.url!, "http://local"), res)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => pc.listen(0, "127.0.0.1", resolve)); const bound = pc.address(); assert.ok(bound && typeof bound === "object");
  const runtime = new RabiLinkRelayRuntime({ localRequestTimeoutMs: 15000, relayWriteAttempts: 1, localRequestAttempts: 1 });
  try {
    await runtime.sync({ enabled: true, url: relayUrl, token, deviceId: "share-pc", deviceGuid: "share-pc", deviceName: "Share PC", claimWaitMs: 1000, localWebguiUrl: `http://127.0.0.1:${bound.port}`, localSpeechUrl: "" });
    // Register this isolated test PC through the production worker heartbeat route.
    const heartbeat = await fetch(relayUrl + "/worker/webgui-requests?deviceId=share-pc&deviceGuid=share-pc&capabilities=webgui&waitMs=0", { headers: { "x-rabilink-token": token } }); assert.equal(heartbeat.status, 200);
    const file = path.join(root, "report.html"); await fs.writeFile(file, "<!doctype html><h1>Real queue report</h1>");
    const link = new URL(await store.publish(file, "real-queue-original"));
    const { randomUUID } = await import("node:crypto"), { websocketChannel } = await import("../peerTunnel/channel.js");
    const room = randomUUID(), socket = new WebSocket(relayUrl.replace("http", "ws") + link.pathname + `/socket?side=viewer&room=${room}`);
    const frames = receive(websocketChannel(socket)); void frames.catch(() => {});
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const offer = await fetch(relayUrl + link.pathname + "/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "relay", room }) });
    assert.equal(offer.status, 200, await offer.text());
    assert.match(decrypt(await frames, link.hash.slice(1)), /Real queue report/);
    const files = await fs.readdir(path.join(root, "relay/html-share-directory")); assert.equal(files.length, 1);
    assert.doesNotMatch(await fs.readFile(path.join(root, "relay/html-share-directory", files[0]), "utf8"), /Real queue report|"key"/);
  } finally {
    await runtime.stop(); await store.stop(); await registration.dispose(); pc.closeAllConnections(); await new Promise<void>(resolve => pc.close(() => resolve()));
    child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    await fs.rm(root, { recursive: true, force: true });
  }
});

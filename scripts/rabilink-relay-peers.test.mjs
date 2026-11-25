import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Relay is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

async function waitForSseEvent(response, expectedType, timeoutMs = 2_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${expectedType}`)), remaining))
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const eventLine = frame.split(/\r?\n/).find(line => line.startsWith("event:"));
      if (eventLine?.slice(6).trim() === expectedType) return reader;
    }
  }
  throw new Error(`SSE event was not received: ${expectedType}`);
}

test("peer discovery and RPC stay isolated while retired synchronization is unavailable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-peers-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const account = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "peer-test", password: "strong-test-password" })
    });
    assert.equal(account.status, 200);
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
    const appResponseA = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Peer sync A" })
    });
    assert.equal(appResponseA.status, 200);
    const tokenA = (await appResponseA.json()).app.token;
    const appResponseB = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Peer sync B" })
    });
    assert.equal(appResponseB.status, 200);
    const tokenB = (await appResponseB.json()).app.token;
    const register = async (token, deviceId, deviceGuid, peerUrls, deviceKind, capabilities = "webgui,persona-sync,persona-sync-plan-package-v1") => {
      const params = new URLSearchParams({
        deviceId,
        deviceGuid,
        deviceName: deviceId,
        waitMs: "0",
        capabilities,
        peerUrls: JSON.stringify(peerUrls)
      });
      if (deviceKind !== undefined) params.set("deviceKind", deviceKind);
      const response = await fetch(`${baseUrl}/worker/webgui-requests?${params}`, {
        headers: { "x-rabilink-token": token }
      });
      assert.equal(response.status, 200);
    };
    const peerObserver = await fetch(`${baseUrl}/api/rabilink/events?${new URLSearchParams({
      deviceId: "pc-a",
      deviceGuid: "guid-a",
      deviceName: "pc-a",
      capabilities: "webgui,persona-sync,persona-sync-plan-package-v1",
      peerUrls: JSON.stringify(["http://192.168.1.10:8790"])
    })}`, {
      headers: { "x-rabilink-token": tokenA, accept: "text/event-stream" }
    });
    assert.equal(peerObserver.status, 200);
    await register(tokenA, "pc-b", "guid-b", ["http://192.168.1.11:8790", "not a URL"], undefined, "webgui,persona-sync,persona-sync-plan-package-v1,rabi-pc-version-0.3.19");
    const peerChangedReader = await waitForSseEvent(peerObserver, "peer_changed");
    await peerChangedReader.cancel();
    await register(tokenB, "pc-c", "guid-c", ["http://192.168.1.12:8790"]);

    const liveEventsUrl = `${baseUrl}/api/rabilink/events?deviceId=pc-live&deviceGuid=guid-live&deviceName=pc-live&capabilities=peer-rpc-v1&peerUrls=${encodeURIComponent(JSON.stringify(["http://192.168.1.13:8790"]))}`;
    const liveEvents = await fetch(liveEventsUrl, {
      headers: { "x-rabilink-token": tokenA, accept: "text/event-stream" }
    });
    assert.equal(liveEvents.status, 200);
    const overlappingLiveEvents = await fetch(liveEventsUrl, {
      headers: { "x-rabilink-token": tokenA, accept: "text/event-stream" }
    });
    assert.equal(overlappingLiveEvents.status, 200);
    const appStorePath = path.join(directory, "apps.json");
    const staleStore = JSON.parse(fs.readFileSync(appStorePath, "utf8"));
    const liveWorker = staleStore.workers.find(worker => worker.guid === "guid-live");
    assert.ok(liveWorker);
    liveWorker.lastSeenAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(appStorePath, JSON.stringify(staleStore, null, 2));

    const peersResponseA = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-a&deviceGuid=guid-a`, {
      headers: { "x-rabilink-token": tokenA }
    });
    assert.equal(peersResponseA.status, 200);
    const peersA = (await peersResponseA.json()).peers;
    assert.equal(peersA.length, 2);
    const activeLivePeer = peersA.find(peer => peer.id === "pc-live");
    assert.ok(activeLivePeer);
    assert.equal(activeLivePeer.online, true);
    assert.deepEqual(activeLivePeer.peerUrls, ["http://192.168.1.13:8790"]);
    const peerB = peersA.find(peer => peer.id === "pc-b");
    assert.ok(peerB);
    assert.deepEqual(peerB.peerUrls, ["http://192.168.1.11:8790"]);
    assert.deepEqual(peerB.capabilities, ["rabi-pc-version-0.3.19", "webgui"]);

    const phoneId = "rabi-phone-fixture";
    const phoneSecret = "a".repeat(64);
    const filePath = "/api/rabilink/mobile/files";
    const stream = await fetch(`${baseUrl}/api/rabilink/events?deviceId=${phoneId}&deviceKind=phone&deviceName=Fixture%20phone`, {
      headers: { "x-rabilink-token": tokenA, "x-rabilink-phone-session": phoneSecret }
    });
    assert.equal(stream.status, 200);
    const login = await fetch(`${baseUrl}/api/rabilink/host-account/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "peer-test", password: "strong-test-password",
        deviceId: "account-fixture", deviceGuid: randomUUID(), deviceName: "Account fixture" })
    });
    assert.equal(login.status, 200);
    const accountToken = (await login.json()).data.token;
    const accountDirectory = async query => (await (await fetch(`${baseUrl}/api/rabilink/peers${query}`, {
      headers: { "x-rabilink-token": accountToken }
    })).json()).peers;
    assert.equal((await accountDirectory("")).some(peer => peer.deviceKind === "phone"), false);
    const phone = (await accountDirectory("?includePortable=phone")).find(peer => peer.deviceKind === "phone");
    assert.equal(phone?.name, "Fixture phone");
    assert.equal(phone.online, true);
    assert.deepEqual(phone.capabilities, ["phone-files-v1"]);
    assert.deepEqual(phone.peerUrls, []);
    const post = (token, suffix, body, session) => fetch(baseUrl + filePath + suffix, {
      method: "POST", headers: { "content-type": "application/json", "x-rabilink-token": token,
        ...(session ? { "x-rabilink-phone-session": session } : {}) }, body: JSON.stringify(body)
    });
    const readInput = { targetId: phone.id, targetGuid: phone.guid, action: "file.list", path: "" };
    assert.equal((await post(tokenB, "", { ...readInput, targetId: phoneId })).status, 404);
    assert.equal((await post(accountToken, "", { ...readInput, targetGuid: "wrong-guid" })).status, 404);
    const call = post(accountToken, "", readInput);
    const phoneReader = await waitForSseEvent(stream, "phone_files_available");
    assert.equal((await post(tokenA, "/claim", { phoneId }, "b".repeat(64))).status, 403);
    const claim = (await (await post(tokenA, "/claim", { phoneId }, phoneSecret)).json()).data;
    assert.equal(claim.action, "file.list");
    assert.deepEqual(claim.input, { path: "" });
    const receipt = { code: 0, data: { entries: [] } };
    assert.equal((await post(tokenA, "/result", { phoneId, requestId: claim.id, status: 200, result: receipt }, phoneSecret)).status, 200);
    const returned = await call;
    assert.equal(returned.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await returned.json(), receipt);
    await phoneReader.cancel();

    await liveEvents.body.cancel();
    const stillConnectedResponse = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-a&deviceGuid=guid-a`, {
      headers: { "x-rabilink-token": tokenA }
    });
    const stillConnectedLivePeer = (await stillConnectedResponse.json()).peers.find(peer => peer.id === "pc-live");
    assert.equal(stillConnectedLivePeer?.online, true);
    const stillConnectedStore = JSON.parse(fs.readFileSync(appStorePath, "utf8"));
    assert.equal(
      String(stillConnectedStore.workers.find(worker => worker.guid === "guid-live")?.lastDisconnectedAt || ""),
      ""
    );

    await overlappingLiveEvents.body.cancel();
    let disconnectedLivePeer;
    for (let attempt = 0; attempt < 20 && disconnectedLivePeer?.online !== false; attempt += 1) {
      const disconnectedResponse = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-a&deviceGuid=guid-a`, {
        headers: { "x-rabilink-token": tokenA }
      });
      disconnectedLivePeer = (await disconnectedResponse.json()).peers.find(peer => peer.id === "pc-live");
      if (disconnectedLivePeer?.online !== false) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(disconnectedLivePeer?.online, false);
    const disconnectedStore = JSON.parse(fs.readFileSync(appStorePath, "utf8"));
    assert.match(
      String(disconnectedStore.workers.find(worker => worker.guid === "guid-live")?.lastDisconnectedAt || ""),
      /^\d{4}-\d{2}-\d{2}T/
    );
    await register(tokenA, "pc-live", "guid-live", ["http://192.168.1.13:8790"]);
    const reconnectedResponse = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-a&deviceGuid=guid-a`, {
      headers: { "x-rabilink-token": tokenA }
    });
    const reconnectedLivePeer = (await reconnectedResponse.json()).peers.find(peer => peer.id === "pc-live");
    assert.equal(reconnectedLivePeer?.online, true);

    const peersResponseB = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-c&deviceGuid=guid-c`, {
      headers: { "x-rabilink-token": tokenB }
    });
    assert.equal(peersResponseB.status, 200);
    assert.deepEqual((await peersResponseB.json()).peers, []);

    const crossAppProxyA = await fetch(`${baseUrl}/api/rabilink/persona-sync/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": tokenA },
      body: JSON.stringify({
        targetDeviceId: "pc-c",
        method: "GET",
        path: "/api/persona-sync/manifest?roleId=Rabi"
      })
    });
    assert.equal(crossAppProxyA.status, 404);

    const crossAppProxyB = await fetch(`${baseUrl}/api/rabilink/persona-sync/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": tokenB },
      body: JSON.stringify({
        targetDeviceId: "pc-b",
        method: "GET",
        path: "/api/persona-sync/manifest?roleId=Rabi"
      })
    });
    assert.equal(crossAppProxyB.status, 404);

    const retiredProxy = await fetch(`${baseUrl}/api/rabilink/persona-sync/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": tokenA },
      body: JSON.stringify({ targetDeviceId: "pc-b", method: "GET", path: "/api/persona-sync/manifest" })
    });
    assert.equal(retiredProxy.status, 404);
    const emptyQueue = await fetch(`${baseUrl}/worker/webgui-requests?deviceId=pc-b&deviceGuid=guid-b&waitMs=0`, {
      headers: { "x-rabilink-token": tokenA }
    });
    assert.deepEqual((await emptyQueue.json()).requests, []);

    // Unified RPC reuses this real queue but cannot choose a Manager path.
    const registerRpc = await fetch(`${baseUrl}/worker/webgui-requests?deviceId=pc-b&deviceGuid=guid-b&deviceName=pc-b&waitMs=0&capabilities=webgui,peer-rpc-v1`, {
      headers: { "x-rabilink-token": tokenA }
    });
    assert.equal(registerRpc.status, 200);
    const rpc = (token, body) => fetch(`${baseUrl}/api/rabilink/peer/proxy`, {
      method: "POST", headers: { "content-type": "application/json", "x-rabilink-token": token }, body: JSON.stringify(body)
    });
    const packet = { version: 1, iv: "opaque", data: "encrypted", tag: "opaque" };
    assert.equal((await rpc(tokenB, { targetDeviceId: "pc-b", packet })).status, 404);
    assert.equal((await rpc(tokenA, { targetDeviceId: "pc-b", packet, path: "/api/agent/send" })).status, 400);
    const rpcPending = rpc(tokenA, { targetDeviceId: "pc-b", packet });
    let rpcClaim;
    for (let attempt = 0; attempt < 30 && !rpcClaim; attempt++) {
      const claim = await fetch(`${baseUrl}/worker/webgui-requests?deviceId=pc-b&deviceGuid=guid-b&deviceName=pc-b&waitMs=100&capabilities=webgui,peer-rpc-v1`, {
        headers: { "x-rabilink-token": tokenA }
      });
      rpcClaim = (await claim.json()).requests?.[0];
    }
    assert.equal(rpcClaim.path, "/api/rabilink/peer/receive");
    assert.deepEqual(JSON.parse(Buffer.from(rpcClaim.bodyBase64, "base64").toString()), packet);
    const rpcFinish = await fetch(`${baseUrl}/worker/webgui-requests/${encodeURIComponent(rpcClaim.id)}/response`, {
      method: "POST", headers: { "content-type": "application/json", "x-rabilink-token": tokenA },
      body: JSON.stringify({ deviceId: "pc-b", deviceGuid: "guid-b", ok: true, statusCode: 200,
        headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify(packet)).toString("base64") })
    });
    assert.equal(rpcFinish.status, 200);
    assert.deepEqual(await (await rpcPending).json(), packet);

    await register(tokenA, "pc-b", "guid-b", [], "pc");
    await register(tokenA, "pc-b", "guid-b", []); // An old request cannot clear the type.
    await register(tokenA, "terminal-a", "", [], "phone");
    await register(tokenA, "terminal-b", "", [], "glasses");
    const typedResponse = await fetch(`${baseUrl}/api/rabilink/peers?deviceId=pc-a&deviceGuid=guid-a`, {
      headers: { "x-rabilink-token": tokenA }
    });
    const typedPeers = (await typedResponse.json()).peers;
    assert.equal(typedPeers.find(peer => peer.id === "pc-b").deviceKind, "pc");
    assert.equal(typedPeers.find(peer => peer.id === "terminal-a").deviceKind, "phone");
    assert.equal(typedPeers.find(peer => peer.id === "terminal-b").deviceKind, "glasses");
    assert.equal(typedPeers.find(peer => peer.id === "pc-live").deviceKind, "unknown");
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});

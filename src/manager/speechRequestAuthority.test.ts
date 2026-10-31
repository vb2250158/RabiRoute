import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { ManagerSpeechControl, type ManagerSpeechLocalAdapter } from "./speechControl.js";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import { SpeechApiOwner, createSpeechApiOperations } from "./speechApiOperations.js";
import type { SpeechApiContext } from "./speechApiContext.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { stickySpeechAuthority, awaitSpeechAuthority } from "./speechRequestAuthority.js";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const status: SpeechRuntimeStatus = { state: "online", checkedAt: "fixture", configuredUrl: "http://127.0.0.1:8781", defaults: {}, providers: { tts: [], asr: [] } };
const modes = ["disable", "instance-aba", "global-aba", "reenroll"] as const;
async function fixture(t: TestContext, handler: http.RequestListener) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-speech-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy());
    if (access.kind !== "agent") { response.writeHead(403); response.end("denied"); return; }
    handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${address.port}/api/speech/status`,
    headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" },
    revoke(mode: typeof modes[number]) {
      if (mode === "global-aba") {
        config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } });
      } else if (mode === "reenroll") {
        authority.revokeNode("fixture-node");
        const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
      } else {
        authority.setNodeEnabled("fixture-node", false);
        if (mode === "instance-aba") {
          authority.setNodeEnabled("fixture-node", true);
          assert.ok(authority.authenticate(credential.token), "Restored instance admits fresh authentication while the original request remains revoked.");
        }
      }
    }
  };
}
function control(requestJson: ManagerSpeechLocalAdapter["requestJson"],
  requestBinary = async () => ({ status: 200, contentType: "audio/wav", headers: {}, body: Buffer.from("private-wave") })) {
  return new ManagerSpeechControl({ serviceUrl: () => status.configuredUrl, personas: () => [], route: () => undefined,
    routes: () => [], deliverTranscript: async () => ({ status: "delivered" }), appendRouteLog() {},
    localSpeech: { inspect: async () => status, requestJson, requestBinary } });
}

test("speech authority retains its first denial across policy recovery and catch", async () => {
  const first = new Error("first denial"); let denied = true; let calls = 0;
  const guard = stickySpeechAuthority(() => { calls++; if (denied) throw first; });
  assert.throws(guard, error => error === first); denied = false;
  assert.throws(guard, error => error === first); assert.equal(calls, 1);
  await assert.rejects(awaitSpeechAuthority(guard, async () => "sensitive"), error => error === first);
});

for (const mode of modes) {
  for (const fails of [false, true]) test(`authenticated speech binary ${fails ? "failure" : "success"} is fenced after ${mode}`, { timeout: 10000 }, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
    const c = control(async () => ({ status: 200, data: {} }), async () => {
      entered.resolve(); await gate.promise;
      if (fails) throw new Error("private upstream failure");
      return { status: 200, contentType: "audio/wav", headers: {}, body: Buffer.from("private-wave") };
    });
    const f = await fixture(t, (request, response) => {
      const guard = stickySpeechAuthority(() => { assertTrustedLanAgentPrincipal(request); });
      void c.synthesize({ input: "fixture", model: "fixture", voice: "fixture", responseFormat: "wav", speed: 1, language: null, instructions: null, play: false, sessionId: null, routeId: null }, guard).then(result => {
        guard(); response.writeHead(200); response.end(result.body);
      }).catch(() => { response.writeHead(403); response.end("denied"); });
    });
    const pending = fetch(f.url, { headers: f.headers });
    await entered.promise; f.revoke(mode); gate.resolve();
    const response = await pending;
    assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /private-wave|private upstream/);
  });

  test(`authenticated microphone reconcile cannot dispatch after ${mode}`, { timeout: 10000 }, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve); const dispatches: string[] = [];
    const c = control(async (_url, pathname) => {
      dispatches.push(pathname); entered.resolve(); await gate.promise;
      return { status: 200, data: { running: false, config: { streaming_enabled: true } } };
    });
    const f = await fixture(t, (request, response) => {
      void c.reconcileMicrophone(() => { assertTrustedLanAgentPrincipal(request); }).then(() => {
        response.writeHead(200); response.end("unexpected");
      }).catch(() => { response.writeHead(403); response.end("denied"); });
    });
    const pending = fetch(f.url, { headers: f.headers });
    await entered.promise; f.revoke(mode); gate.resolve();
    assert.equal((await pending).status, 403); assert.deepEqual(dispatches, ["/v1/microphone/status"]);
  });

  for (const action of ["start", "stop"] as const) test(`authenticated queued runtime ${action} cannot dispatch after ${mode}`, { timeout: 10000 }, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let inspections = 0; let launches = 0;
    const runtime = new SpeechRuntimeControl({ rootDir: ".", platform: "win32", serviceUrl: () => status.configuredUrl,
      existsSync: () => true, inspect: async () => { inspections++; entered.resolve(); await gate.promise; return status; },
      spawnRuntime: () => { launches++; return { pid: 1, exitCode: null, unref() {} }; } });
    const blocker = runtime.start(); await entered.promise;
    const queued = deferred();
    const f = await fixture(t, (request, response) => {
      const pending = runtime[action](() => { assertTrustedLanAgentPrincipal(request); }); queued.resolve();
      void pending.then(() => { response.writeHead(200); response.end("unexpected"); })
        .catch(() => { response.writeHead(403); response.end("denied"); });
    });
    const pending = fetch(f.url, { headers: f.headers }); await queued.promise;
    f.revoke(mode); gate.resolve(); await blocker;
    assert.equal((await pending).status, 403); assert.equal(inspections, 1); assert.equal(launches, 0);
  });
  test(`authenticated SSE outgoing chunk is fenced after ${mode}`, { timeout: 10000 }, async t => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const owner = new SpeechApiOwner({
      speechControl: { eventStream: async (signal: AbortSignal) => new Response(new ReadableStream({ start(controller) {
        stream = controller; controller.enqueue(new TextEncoder().encode("data: allowed\n\n"));
        signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }) },
      capture: (request: http.IncomingMessage) => ({ guard: stickySpeechAuthority(() => { assertTrustedLanAgentPrincipal(request); }), run: <T>(action: () => T) => action(), targetLocal: false })
    } as unknown as SpeechApiContext);
    const registry = new ManagerPluginRouteRegistry(); const registration = registry.registerOperations("speech-authority-fixture", createSpeechApiOperations(owner).operations.filter(value => value.contract.operationId === "manager.speech.events"));
    t.after(async () => { await Promise.all([registration.dispose(), owner.events.stop()]); });
    const f = await fixture(t, (request, response) => { if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
    const response = await fetch(f.url.replace("/status", "/events"), { headers: f.headers }); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /allowed/);
    f.revoke(mode); stream.enqueue(new TextEncoder().encode("data: private-stale-event\n\n"));
    await assert.rejects(reader.read()); assert.equal(aborted, true);
  });
}

test("a revoked status waiter does not poison the Manager-owned shared probe", async () => {
  const gate = deferred(); let denied = false; let inspections = 0;
  const c = new ManagerSpeechControl({ serviceUrl: () => status.configuredUrl, personas: () => [], route: () => undefined,
    routes: () => [], deliverTranscript: async () => ({ status: "delivered" }), appendRouteLog() {},
    localSpeech: { inspect: async () => { inspections++; await gate.promise; return status; },
      requestJson: async () => ({ status: 200, data: {} }), requestBinary: async () => { throw new Error("unused"); } } });
  const stale = c.status(() => { if (denied) throw new Error("revoked"); }); const fresh = c.status();
  denied = true; gate.resolve(); await assert.rejects(stale, /revoked/); assert.equal(await fresh, status);
  assert.equal(await c.status(), status); assert.equal(inspections, 1);
});

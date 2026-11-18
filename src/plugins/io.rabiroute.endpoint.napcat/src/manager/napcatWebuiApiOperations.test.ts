import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { rootCertificates } from "node:tls";
import test from "node:test";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatWebuiApiOperations, napcatWebuiApiReadSpecs, projectNapcatWebuiSslStatus,
  type NapcatWebuiApiContext } from "./napcatWebuiApiOperations.js";

const baseRoute = { id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "fixture-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-onebot-token", botUserId: "12345" }
] } as GatewayDefinition;
const envelope = (data: unknown) => Response.json({ code: 0, data });
const status = { cpu: { core: 4, model: "Fixture CPU", speed: "2.50", usage: { system: "1.0", qq: "0.5" }, token: "PRIVATE_FIXTURE" },
  memory: { total: "4000", usage: { system: "1000", qq: "50" } }, arch: "fixture" };
const plugin = { id: "fixture-plugin", name: "Fixture plugin", version: "1.0.0", status: "active", hasConfig: true,
  token: "PRIVATE_FIXTURE", config: { password: "PRIVATE_FIXTURE" }, downloadUrl: "https://user:PRIVATE_FIXTURE@download.example/asset?token=PRIVATE_FIXTURE" };
const fixtures: Record<string, () => Response> = {
  mirrors: () => envelope({ mirrors: ["https://user:PRIVATE_FIXTURE@mirror.example/private?token=PRIVATE_FIXTURE", 42] }),
  "file-hash": () => envelope({ hash: "aa".repeat(64), file: "napcat.mjs", algorithm: "sha512", token: "PRIVATE_FIXTURE" }),
  version: () => envelope({ version: "4.18.4", Credential: "PRIVATE_FIXTURE" }),
  "system-events": () => new Response(`data: ${JSON.stringify(status)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
  "qq-version": () => envelope("9.9.26-44498"),
  theme: () => envelope({ fontMode: "system", dark: { one: "PRIVATE_FIXTURE" }, light: {} }),
  schemas: () => envelope({ get_example: { description: "Example", tags: ["read"], payload: {}, response: {}, payloadExample: "PRIVATE_FIXTURE" } }),
  log: () => envelope("password=PRIVATE_FIXTURE\nBearer PRIVATE_FIXTURE"),
  "log-files": () => envelope(["fixture-log", "../outside", "C:\\private"]),
  "log-events": () => new Response("data: token=PRIVATE_FIXTURE\n\n", { headers: { "content-type": "text/event-stream" } }),
  "plugin-icon": () => new Response("PRIVATE_FIXTURE", { headers: { "content-type": "image/png" } }),
  plugins: () => envelope({ plugins: [plugin, { id: "../private" }] }),
  "plugin-page": () => new Response("<script>PRIVATE_FIXTURE</script>", { headers: { "content-type": "text/html" } }),
  "store-plugin": () => envelope(plugin),
  "store-plugins": () => envelope({ plugins: [plugin] }),
  health: () => envelope({ token: "PRIVATE_FIXTURE" }),
  "ssl-status": () => envelope({ enabled: true, certExists: true, keyExists: true,
    certContent: rootCertificates[0], keyContent: "PRIVATE_FIXTURE", Credential: "PRIVATE_FIXTURE" }),
};

function setup(response?: (id: string, path: string) => Response, webuiUserId = 12345) {
  let route = baseRoute;
  const calls: Array<{ method: string; pathname: string }> = [];
  let identityCalls = 0, sessionCalls = 0;
  const context: NapcatWebuiApiContext = {
    local: () => true, route: () => route,
    transport: async () => { identityCalls++; return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } }); },
    openWebuiSession: async selection => {
      sessionCalls++;
      return { assertCurrent: () => selection.assertCurrent(), requestFixed: async (method, pathname) => {
        calls.push({ method, pathname });
        if (pathname === "/api/QQLogin/GetQQLoginInfo") return envelope({ uin: webuiUserId, secret: "PRIVATE_FIXTURE" });
        const spec = napcatWebuiApiReadSpecs.find(item => pathname.split("?")[0] === item.upstreamPath ||
          item.id === "plugin-icon" && pathname.startsWith("/api/Plugin/Icon/") ||
          item.id === "plugin-page" && pathname.startsWith("/api/Plugin/page/") ||
          item.id === "store-plugin" && pathname.startsWith("/api/Plugin/Store/Detail/"));
        assert.ok(spec, `Unexpected provider path ${pathname}`);
        return response?.(spec.id, pathname) ?? fixtures[spec.id]!();
      } };
    }
  };
  const operations = createNapcatWebuiApiOperations(context);
  const operation = (id: string) => operations.find(item => item.contract.operationId === `agent.qq.webui.${id}`)!;
  const input = (id: string, params: Record<string, unknown> = {}): ApiOperationInput => ({
    request: { headers: {} } as IncomingMessage, response: {}, url: new URL(`http://127.0.0.1/api/agent/qq/webui/${id}`),
    path: {}, query: {}, body: { routeId: "fixture", instanceId: "fixture-instance", params }
  }) as ApiOperationInput;
  return { context, calls, operations, operation, input, setRoute: (value: GatewayDefinition) => { route = value; },
    counts: () => ({ identityCalls, sessionCalls }) };
}

test("all 17 fixed management reads execute with original identity and projected results", async () => {
  const f = setup();
  assert.equal(f.operations.length, 17);
  for (const spec of napcatWebuiApiReadSpecs) {
    const params = spec.id === "log" ? { id: "fixture-log" } : spec.id === "plugin-page" ? { pluginId: "fixture-plugin", pagePath: "status" }
      : spec.id === "plugin-icon" ? { pluginId: "fixture-plugin" } : spec.id === "store-plugin" ? { id: "fixture-plugin" } : {};
    const result = await f.operation(spec.id).handler(f.input(spec.id, params));
    assert.equal(result.status, 200, spec.id + " " + JSON.stringify(result.body));
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_FIXTURE|keyContent|certContent|password|Credential/);
  }
  assert.equal(f.calls.length, 34);
  assert.deepEqual(f.counts(), { identityCalls: 17, sessionCalls: 17 });
  assert.equal(f.calls.find(item => item.pathname === "/api/test")?.method, "POST");
  assert.equal(f.calls.filter(item => item.method === "GET").length, 16);
});

test("extra URL, headers, credentials, arbitrary actions and host paths stop before any provider call", async () => {
  const f = setup();
  const attempts = [
    { ...f.input("version"), body: { ...(f.input("version").body as object), url: "http://private" } },
    f.input("version", { action: "send_packet" }), f.input("version", { headers: { authorization: "private" } }),
    f.input("version", { webui_token: "private" }), f.input("plugin-page", { pluginId: "fixture", pagePath: "C:\\secret" }),
    f.input("plugin-page", { pluginId: "fixture", pagePath: "../secret" }), f.input("plugin-icon", { pluginId: "../secret" }),
    f.input("log", { id: "../webui" }), f.input("log", { id: "C:\\webui.json" }),
    { ...f.input("version"), query: { url: "http://private" } },
    { ...f.input("version"), url: new URL("http://127.0.0.1/api/agent/qq/webui/unregistered") },
  ] as ApiOperationInput[];
  for (const input of attempts) assert.equal((await f.operation(input.url.pathname.endsWith("unregistered") ? "version" : input.url.pathname.split("/").at(-1)!).handler(input)).status, 400);
  assert.deepEqual(f.counts(), { identityCalls: 0, sessionCalls: 0 });
  assert.equal(f.calls.length, 0);
});

test("only declared selectors become provider query or encoded path segments", async () => {
  const f = setup();
  assert.equal((await f.operation("store-plugins").handler(f.input("store-plugins", { forceRefresh: true }))).status, 200);
  assert.equal(f.calls.at(-1)?.pathname, "/api/Plugin/Store/List?forceRefresh=true");
  assert.equal((await f.operation("plugin-page").handler(f.input("plugin-page", { pluginId: "fixture", pagePath: "nested/status" }))).status, 200);
  assert.equal(f.calls.at(-1)?.pathname, "/api/Plugin/page/fixture/nested%2Fstatus");
});

test("SSL status exposes certificate metadata while malformed certificates retain an explicit local state", () => {
  const cert = new X509Certificate(rootCertificates[0]!);
  const data = projectNapcatWebuiSslStatus({ enabled: true, certExists: true, keyExists: true,
    certContent: rootCertificates[0], keyContent: "PRIVATE_FIXTURE" });
  assert.equal((data.certificate as Record<string, unknown>).fingerprint256, cert.fingerprint256);
  assert.doesNotMatch(JSON.stringify(data), /BEGIN CERTIFICATE|PRIVATE_FIXTURE|keyContent/);
  const invalid = projectNapcatWebuiSslStatus({ enabled: true, certExists: true, keyExists: true, certContent: "invalid PRIVATE_FIXTURE" });
  assert.deepEqual(invalid.certificate, { status: "invalid" });
  assert.throws(() => projectNapcatWebuiSslStatus({ enabled: "true" }), /QQ_WEBUI_RESPONSE_INVALID/);
});

test("one malformed directory row is reported without losing valid metadata", async () => {
  const f = setup();
  const plugins = await f.operation("plugins").handler(f.input("plugins"));
  assert.equal(plugins.status, 200);
  const data = (plugins.body as { data: { items: unknown[]; invalidItems: number } }).data;
  assert.equal(data.items.length, 1); assert.equal(data.invalidItems, 1);
  const logs = await f.operation("log-files").handler(f.input("log-files"));
  assert.deepEqual((logs.body as { data: unknown }).data, { items: ["fixture-log"], invalidItems: 2 });
});

test("samples handle split CRLF, count malformed events and cancel the upstream reader", async () => {
  let cancelled = false;
  const f = setup(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("data: invalid\r"));
    controller.enqueue(new TextEncoder().encode(`\n\r\ndata: ${JSON.stringify(status)}\r\n\r\n`));
  }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
  const result = await f.operation("system-events").handler(f.input("system-events", { maxEvents: 2 }));
  assert.equal(result.status, 200);
  const data = (result.body as { data: { events: unknown[]; invalidEvents: number } }).data;
  assert.equal(data.events.length, 1); assert.equal(data.invalidEvents, 1); assert.equal(cancelled, true);
});

test("cancelled stream reads settle and release the original stream", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const f = setup(() => {
    setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const result = await f.operation("log-events").handler({ ...f.input("log-events"), signal: controller.signal });
  assert.equal(result.status, 503); assert.equal(cancelled, true);
});

test("a read deadline retains received events as an explicitly timed-out sample", async () => {
  const previous = process.env.RABIROUTE_QQ_READ_TIMEOUT_MS;
  process.env.RABIROUTE_QQ_READ_TIMEOUT_MS = "50";
  try {
    const f = setup(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: PRIVATE_FIXTURE\n\n"));
    } }), { headers: { "content-type": "text/event-stream" } }));
    const result = await f.operation("log-events").handler(f.input("log-events", { maxEvents: 2 }));
    assert.equal(result.status, 200);
    const data = (result.body as { data: { timedOut: boolean; ended: boolean; events: unknown[] } }).data;
    assert.equal(data.timedOut, true); assert.equal(data.ended, false); assert.equal(data.events.length, 1);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_FIXTURE/);
  } finally {
    if (previous === undefined) delete process.env.RABIROUTE_QQ_READ_TIMEOUT_MS;
    else process.env.RABIROUTE_QQ_READ_TIMEOUT_MS = previous;
  }
});

test("binding changes or an actual QQ mismatch stop the fixed WebUI read", async () => {
  const changed = setup();
  changed.context.openWebuiSession = async () => {
    changed.setRoute({ ...baseRoute, napcatInstances: [{ ...baseRoute.napcatInstances![0]!, botUserId: "54321" }] });
    return { assertCurrent() {}, requestFixed: async () => { throw new Error("must not run"); } };
  };
  assert.equal((await changed.operation("version").handler(changed.input("version"))).status, 409);
  assert.equal(changed.calls.length, 0);
  const mismatch = setup();
  mismatch.context.transport = async () => Response.json({ status: "ok", retcode: 0, data: { user_id: 54321 } });
  assert.equal((await mismatch.operation("version").handler(mismatch.input("version"))).status, 409);
  assert.equal(mismatch.counts().sessionCalls, 0);
  const wrongWebui = setup(undefined, 54321);
  assert.equal((await wrongWebui.operation("version").handler(wrongWebui.input("version"))).status, 409);
  assert.deepEqual(wrongWebui.calls.map(call => call.pathname), ["/api/QQLogin/GetQQLoginInfo"]);
});

test("upstream errors and untrusted resource types expose only stable error codes", async () => {
  const f = setup(() => Response.json({ code: -1, message: "PRIVATE_FIXTURE" }));
  const result = await f.operation("version").handler(f.input("version"));
  assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_FIXTURE/);
  const resource = await f.operation("plugin-icon").handler(f.input("plugin-icon", { pluginId: "fixture" }));
  assert.equal(resource.status, 503);
  const session = setup();
  session.context.openWebuiSession = async () => { throw new Error("PRIVATE_FIXTURE http://user:secret@host"); };
  assert.equal((await session.operation("version").handler(session.input("version"))).status, 503);
});

test("body quotas apply to native JSON reads and summaries never contain the log contents", async () => {
  const previous = process.env.RABIROUTE_QQ_JSON_MAX_BYTES;
  process.env.RABIROUTE_QQ_JSON_MAX_BYTES = "200";
  try {
    const f = setup(() => envelope({ version: "x".repeat(500) }));
    assert.equal((await f.operation("version").handler(f.input("version"))).status, 413);
  } finally {
    if (previous === undefined) delete process.env.RABIROUTE_QQ_JSON_MAX_BYTES;
    else process.env.RABIROUTE_QQ_JSON_MAX_BYTES = previous;
  }
  const f = setup();
  const result = await f.operation("log").handler(f.input("log", { id: "fixture" }));
  const text = "password=PRIVATE_FIXTURE\nBearer PRIVATE_FIXTURE";
  assert.deepEqual((result.body as { data: unknown }).data, { bytes: Buffer.byteLength(text), lines: 2, sha256: createHash("sha256").update(text).digest("hex") });
});

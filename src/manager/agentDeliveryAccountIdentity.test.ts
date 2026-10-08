import assert from "node:assert/strict";
import test from "node:test";
import { readQqVerificationAccountIdentity } from "./agentDeliveryAccountIdentity.js";
const readIdentity = async (...args: Parameters<typeof readQqVerificationAccountIdentity>) => (await readQqVerificationAccountIdentity(...args))?.selfId;
import type { CurrentQqFileBinding } from "./agentDeliveryVerification.js";

const binding = (httpUrl = "http://127.0.0.1:12345", accessToken = "fake-test-token"): CurrentQqFileBinding => ({
  routeId: "test-route", instanceId: "test-instance", groupId: "12345", selfId: "123456", bindingRevision: "test-revision",
  readAllowed: true, endpoint: { httpUrl, accessToken }
});
const signal = () => new AbortController().signal;
const envelope = (user_id: unknown) => JSON.stringify({ status: "ok", retcode: 0, data: { user_id } });
const fake = (body = envelope("123456"), init?: ResponseInit): typeof fetch => async () => new Response(body, init);

test("fixed action, local token only, and canonical loopback origins", async () => {
  for (const origin of ["http://127.0.0.1:12345", "http://127.0.0.1/", "http://[::1]:12345/"]) {
    let calls = 0;
    const transport: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), `${new URL(origin).origin}/get_login_info`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.body, "{}");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-test-token");
      assert.ok(!String(url).includes("fake-test-token"));
      return new Response(envelope(123456));
    };
    assert.equal(await readIdentity(binding(origin), signal(), transport), "123456");
    assert.equal(calls, 1);
  }
});

test("URL boundary rejects normalization tricks before transport", async () => {
  const rejected = ["", "https://127.0.0.1", "http://localhost", "http://127.0.0.2", "http://example.invalid", "http://127.1", "http://2130706433", "http://0x7f000001", "http://[::ffff:127.0.0.1]", "http://user:pass@127.0.0.1", "http://@127.0.0.1", "http://127.0.0.1?", "http://127.0.0.1#", "http://127.0.0.1/?token=fake", "http://127.0.0.1/path", "http://127.0.0.1/../", "http://127.0.0.1//", " http://127.0.0.1", "http://127.0.0.1:65536", "http://127.0.0.1:0"];
  for (const origin of rejected) {
    assert.equal(await readIdentity(binding(origin), signal(), async () => { assert.fail(`Unexpected transport: ${origin}`); }), undefined);
  }
  assert.equal(await readIdentity({ ...binding(), readAllowed: false }, signal(), async () => { assert.fail("Denied binding"); }), undefined);
});

test("HTTP, redirects and protocol failures never produce account fallback", async () => {
  for (const status of [301, 302, 307, 400, 401, 500]) assert.equal(await readIdentity(binding(), signal(), fake(envelope("123456"), { status })), undefined);
  for (const body of ["not json", "{}", '{"user_id":"123456"}', '{"status":"failed","retcode":0,"data":{"user_id":"123456"}}', '{"status":"ok","retcode":1,"data":{"user_id":"123456"}}', '{"status":"ok","retcode":"0","data":{"user_id":"123456"}}']) {
    assert.equal(await readIdentity(binding(), signal(), fake(body)), undefined);
  }
  const redirected = new Response(envelope("123456"));
  Object.defineProperty(redirected, "redirected", { value: true });
  assert.equal(await readIdentity(binding(), signal(), async () => redirected), undefined);
  const wrongUrl = new Response(envelope("123456"));
  Object.defineProperty(wrongUrl, "url", { value: "http://example.invalid/get_login_info" });
  assert.equal(await readIdentity(binding(), signal(), async () => wrongUrl), undefined);
  assert.equal(await readIdentity(binding(), signal(), async () => { throw new Error("fake-test-token"); }), undefined);
});

test("identity accepts only canonical positive bounded decimal ids", async () => {
  for (const id of ["123456", 123456, "9999999999999999"]) assert.equal(await readIdentity(binding(), signal(), fake(envelope(id))), String(id));
  for (const id of ["", "0", 0, -1, 1.2, "012345", " 123456", "123456\n", "+123456", "1e6", "１２３", "12345678901234567", Number.MAX_SAFE_INTEGER + 1, true, null, {}, []]) {
    assert.equal(await readIdentity(binding(), signal(), fake(envelope(id))), undefined);
  }
});

test("response byte budget applies to advertised and streamed sizes", async () => {
  assert.equal(await readIdentity(binding(), signal(), fake(envelope("123456"), { headers: { "content-length": "262145" } })), undefined);
  assert.equal(await readIdentity(binding(), signal(), fake(envelope("123456"), { headers: { "content-length": "invalid" } })), undefined);
  assert.equal(await readIdentity(binding(), signal(), fake(" ".repeat(262145))), undefined);
  assert.equal(await readIdentity(binding(), signal(), fake(envelope("123456") + " ".repeat(262144 - envelope("123456").length))), "123456");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  assert.equal(await readIdentity(binding(), signal(), async () => new Response(stream)), undefined);
  assert.equal(cancelled, true);
});

test("caller abort bounds a transport ignoring signals and a stalled body", async () => {
  const before = new AbortController();
  before.abort();
  assert.equal(await readIdentity(binding(), before.signal, async () => { assert.fail("Already aborted"); }), undefined);
  for (const bodyStall of [false, true]) {
    const controller = new AbortController();
    const transport: typeof fetch = async () => bodyStall ? new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })) : new Promise(() => {});
    const pending = readIdentity(binding(), controller.signal, transport);
    controller.abort();
    assert.equal(await pending, undefined);
  }
});

test("three-second deadline bounds an infinite stalled response without token leakage", async () => {
  let aborted: AbortSignal | undefined;
  const start = Date.now();
  assert.equal(await readIdentity(binding(), signal(), async (_url, init) => {
    aborted = init?.signal ?? undefined;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }));
  }), undefined);
  assert.ok(Date.now() - start >= 2900);
  assert.ok(Date.now() - start < 5000);
  assert.equal(aborted?.aborted, true);
  assert.equal(await readIdentity(binding("http://127.0.0.1", "fake\r\ntoken"), signal(), async () => { assert.fail("Unsafe header"); }), undefined);
});

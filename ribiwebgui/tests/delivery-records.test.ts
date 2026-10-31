import assert from "node:assert/strict";
import test from "node:test";
import { readDeliveryComputers, readDeliveryRecord, readDeliveryRecords } from "../src/deliveries/deliveryRecordClient";
import { deliveryRecordCopy, deliveryStateLabels } from "../src/deliveries/deliveryRecordCopy";
import { deliveryComputerOptions, deliveryEndpointLabel, deliveryStatePresentation, deliveryTimeLabel } from "../src/deliveries/deliveryRecordPresentation";

test("reads only the existing owner using encoded filters and opaque pagination", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ code: 0, data: { records: [], nextCursor: "next+/=", observedAt: "2026-01-01T00:00:00Z", coverage: { scope: "manager", includesDisconnectedNodeQueues: false } } });
  };
  const page = await readDeliveryRecords({ state: "awaiting_confirmation", query: "task +/", cursor: "opaque+/=", limit: 25 }, new AbortController().signal, fetcher);
  const url = new URL(calls[0].input, "https://example.invalid");
  assert.equal(url.pathname, "/api/agent/deliveries");
  assert.equal(url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(url.searchParams.get("query"), "task +/");
  assert.equal(url.searchParams.get("state"), "awaiting_confirmation");
  assert.equal(url.searchParams.get("limit"), "25");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(page.coverage.includesDisconnectedNodeQueues, false);
});

test("details encode the original delivery ID and never send or reconcile", async () => {
  const calls: string[] = [];
  await readDeliveryRecord("original/id?+", new AbortController().signal, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return Response.json({ code: 0, data: { deliveryId: "original/id?+", state: "awaiting_confirmation" } });
  });
  assert.deepEqual(calls, ["/api/agent/deliveries/original%2Fid%3F%2B"]);
});

test("selected computer is explicit in list and details without changing the delivery ID", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    calls.push(String(input));
    return Response.json({ code: 0, data: { records: [], coverage: { scope: "node", nodeId: "node+/", connected: true, includesDisconnectedNodeQueues: false } } });
  };
  await readDeliveryRecords({ nodeId: "node+/" }, new AbortController().signal, fetcher);
  await readDeliveryRecord("original", new AbortController().signal, fetcher, "node+/");
  assert.equal(new URL(calls[0], "https://example.invalid").searchParams.get("nodeId"), "node+/");
  assert.equal(new URL(calls[1], "https://example.invalid").searchParams.get("nodeId"), "node+/");
  assert.equal(new URL(calls[1], "https://example.invalid").pathname, "/api/agent/deliveries/original");
});

test("computer selector reuses the instance catalog with aliases and preserves offline targets", async () => {
  const calls: string[] = [];
  const instances = await readDeliveryComputers(new AbortController().signal, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    return Response.json({ code: 0, instances: [
      { instanceId: "local", local: true, connected: true, agents: [] },
      { instanceId: "node-online", name: "Online computer", local: false, connected: true, agents: [] },
      { instanceId: "node-offline", hostname: "Offline computer", local: false, connected: false, agents: [] }
    ] });
  });
  assert.deepEqual(calls, ["/api/lan-agent/instances"]);
  const options = deliveryComputerOptions(instances, "en", "node-offline");
  assert.deepEqual(options, [
    { title: "Current host", value: "" },
    { title: "Online computer · Online", value: "node-online" },
    { title: "Offline computer · Offline", value: "node-offline" }
  ]);
  assert.deepEqual(deliveryComputerOptions([], "en", "original-target").map(option => option.value), ["", "original-target"]);
});

test("offline client records remain explicitly unavailable instead of an empty successful list", async () => {
  await assert.rejects(readDeliveryRecords({ nodeId: "original-target" }, new AbortController().signal, async () =>
    Response.json({ code: -1, message: "fixture_original_computer_offline" }, { status: 503 })), /fixture_original_computer_offline/);
});

test("HTTP acceptance and reply policy never manufacture target acceptance", async () => {
  const page = await readDeliveryRecords({}, new AbortController().signal, async () => Response.json({ code: 0, data: {
    records: [{ deliveryId: "original", state: "awaiting_confirmation", responsePolicy: "none" }], coverage: { scope: "manager", includesDisconnectedNodeQueues: false }
  } }, { status: 202 }));
  assert.equal(page.records[0].state, "awaiting_confirmation");
  assert.equal(deliveryStatePresentation(page.records[0].state, "zh-CN").label, "待确认");
  assert.equal(deliveryStatePresentation("committed", "zh-CN").label, "状态未知");
  assert.equal(deliveryStatePresentation("received", "zh-CN").label, "目标已接收");
});

test("unavailable APIs preserve failures and do not substitute an empty history or retry", async () => {
  let count = 0;
  await assert.rejects(readDeliveryRecords({}, new AbortController().signal, async () => {
    count++;
    return Response.json({ code: -1, message: "fixture_store_unavailable" }, { status: 503 });
  }), /fixture_store_unavailable/);
  assert.equal(count, 1);
});

test("cancellation reaches the transport without a second read", async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(readDeliveryRecords({}, controller.signal, async (_input, init) => {
    count++;
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("expected abort");
  }), { name: "AbortError" });
  assert.equal(count, 1);
});

test("unknown historical metadata stays unknown; full endpoint identities remain visible", () => {
  assert.equal(deliveryTimeLabel(undefined, "zh-CN"), "未记录");
  assert.equal(deliveryEndpointLabel({}, "en"), "Not recorded");
  assert.equal(deliveryEndpointLabel({ instanceId: "computer", provider: "codex-desktop", sessionId: "full-task-id" }, "zh-CN"), "computer · codex-desktop · full-task-id");
  assert.equal(deliveryTimeLabel("legacy-unparsed-time", "en"), "legacy-unparsed-time");
});

test("all three UI languages distinguish queued, uncertain, failed, cancelled and received", () => {
  for (const locale of ["zh-CN", "en", "ja"] as const) {
    const labels = deliveryStateLabels[locale];
    assert.equal(new Set(Object.values(labels)).size, Object.keys(labels).length);
    assert.equal(deliveryStatePresentation("received", locale).color, "success");
    assert.notEqual(deliveryStatePresentation("awaiting_confirmation", locale).color, "success");
    assert.notEqual(deliveryStatePresentation("local_accepted", locale).color, "success");
    assert(deliveryRecordCopy(locale).coverage);
  }
});

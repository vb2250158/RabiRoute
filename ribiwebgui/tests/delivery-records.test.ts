import assert from "node:assert/strict";
import test from "node:test";
import { deliveryRecordOwnerId, readDeliveryComputers, readDeliveryRecord, readDeliveryRecords, recoverDeliveryRecord } from "../../src/plugins/io.rabiroute.manager.diagnostics/web/deliveries/deliveryRecordClient";
import { deliveryRecordCopy, deliveryStateLabels } from "../../src/plugins/io.rabiroute.manager.diagnostics/web/deliveries/deliveryRecordCopy";
import { deliveryComputerOptions, deliveryEndpointLabel, deliveryStatePresentation, deliveryTimeLabel } from "../../src/plugins/io.rabiroute.manager.diagnostics/web/deliveries/deliveryRecordPresentation";
import * as presentation from "../../src/plugins/io.rabiroute.manager.diagnostics/web/deliveries/deliveryRecordPresentation";
import fs from "node:fs";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";

test("recovery posts once to the original computer and ID, then independently reads persisted state", async () => {
  for (const action of ["cancel", "reconcile"] as const) {
    const calls: { path: string; init?: RequestInit }[] = [];
    const record = await recoverDeliveryRecord("original/id?+", action, new AbortController().signal, async (input, init) => {
      calls.push({ path: String(input), init });
      return Response.json({ code: 0, data: { deliveryId: "original/id?+", state: calls.length === 1 ? "received" : "awaiting_confirmation" } });
    }, "node+/");
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].path, "https://example.invalid").pathname, `/api/agent/deliveries/original%2Fid%3F%2B/${action}`);
    for (const call of calls) assert.equal(new URL(call.path, "https://example.invalid").searchParams.get("nodeId"), "node+/");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, "{}");
    assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
    assert.equal(calls[1].init?.method, "GET");
    assert.equal(record.state, "awaiting_confirmation");
  }
});

test("recovery errors and readback failures never retry the mutation", async () => {
  for (const status of [404, 409, 503]) {
    let calls = 0;
    await assert.rejects(recoverDeliveryRecord("original", "cancel", new AbortController().signal, async () => {
      calls++; return Response.json({ code: -1, message: "owner rejected" }, { status });
    }), /owner rejected/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(recoverDeliveryRecord("original", "reconcile", new AbortController().signal, async () => {
    calls++;
    if (calls === 1) return Response.json({ code: 0, data: { state: "received" } });
    throw new Error("readback unavailable");
  }), /readback unavailable/);
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recoverDeliveryRecord("original", "cancel", controller.signal, async () => { throw new Error("must not send"); }), { name: "AbortError" });
});

function recoveryPage(recover: (...args: any[]) => Promise<any>, read?: (...args: any[]) => Promise<any>) {
  const source = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.diagnostics/web/pages/DeliveryRecordsPage.vue", import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "delivery-recovery" });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const output = { exports: {} as any };
  const route = vue.reactive({ query: { nodeId: "node-original" } });
  const record = { id: "original", deliveryId: "original", state: "awaiting_confirmation", source: {}, target: {}, ownerScope: "node" };
  vm.runInNewContext(compiled.outputText, { module: output, exports: output.exports, console, Error, AbortController, fetch,
    require(name: string) {
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
      if (name === "vue-router") return { useRoute: () => route, useRouter: () => ({ replace() {} }) };
      if (name === "../../../../../ribiwebgui/src/i18n/index") return { useI18n: () => ({ locale: vue.ref("zh-CN") }) };
      if (name === "../../../../../ribiwebgui/src/userFacingError") return { userFacingError: (error: Error) => error.message };
      if (name === "../deliveries/deliveryRecordCopy") return { deliveryRecordCopy, deliveryStateLabels };
      if (name === "../deliveries/deliveryRecordPresentation") return presentation;
      if (name === "../deliveries/deliveryRecordClient") return {
        deliveryRecordOwnerId,
        readDeliveryComputers: async () => [], readDeliveryRecords: async () => ({ records: [record], observedAt: "fixture", coverage: {} }),
        readDeliveryRecord: read ?? (async () => ({ ...record })), recoverDeliveryRecord: recover
      };
      throw new Error("Unexpected import " + name);
    }
  });
  return { page: output.exports.default.setup({}, { expose() {} }), route, record };
}

test("recovery UI keeps saved state on failure and adopts only readback", async () => {
  let reject = true;
  const { page, record } = recoveryPage(async () => {
    if (reject) throw new Error("readback unavailable");
    return { ...record, state: "cancelled" };
  });
  await page.showDetails(record);
  await page.recover("cancel");
  assert.equal(page.detail.value.state, "awaiting_confirmation");
  assert.match(page.detailError.value, /readback unavailable/);
  assert.equal(page.actionBusy.value, "");
  reject = false;
  await page.recover("cancel");
  assert.equal(page.detail.value.state, "cancelled");
  assert.equal(page.records.value[0].state, "cancelled");
  assert.match(page.actionNotice.value, /已取消/);
  assert.equal(page.canCancel.value, false);
  page.detail.value = { ...record, state: "blocked", errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE" };
  assert.equal(page.canCancel.value, false);
});

test("detail refresh reads only and retains its previous snapshot when unavailable", async () => {
  let unavailable = false;
  const record = { id: "original", deliveryId: "original", state: "awaiting_confirmation", source: {}, target: {}, ownerScope: "node" };
  const { page } = recoveryPage(async () => { throw new Error("must not mutate"); }, async () => {
    if (unavailable) throw new Error("offline");
    return record;
  });
  await page.showDetails(record);
  unavailable = true;
  await page.showDetails(record, true);
  assert.equal(page.detail.value.deliveryId, "original");
  assert.equal(page.detail.value.state, "awaiting_confirmation");
  assert.equal(page.detailError.value, "offline");
  assert.equal(page.detailLoading.value, false);
});

test("local cancellation pending at the Manager remains visibly unresolved and can reconcile", async () => {
  const actions: string[] = [];
  const { page, record } = recoveryPage(async (_id, action) => {
    actions.push(action);
    return { ...record, state: "cancelled", managerCancelPending: action === "cancel" };
  });
  await page.showDetails(record);
  await page.recover("cancel");
  assert.equal(page.detail.value.state, "cancelled");
  assert.equal(page.canReconcile.value, true);
  assert.equal(page.canCancel.value, false);
  assert.equal(page.recordStatus(page.detail.value).color, "warning");
  assert.equal(page.recordStatus(page.records.value[0]).label, "取消待核对");
  assert.match(page.actionNotice.value, /取消待核对/);
  await page.recover("reconcile");
  assert.deepEqual(actions, ["cancel", "reconcile"]);
  assert.equal(page.detail.value.managerCancelPending, false);
  assert.equal(page.canReconcile.value, false);
  assert.equal(page.recordStatus(page.detail.value).label, "已取消");
  for (const locale of ["zh-CN", "en", "ja"] as const) {
    const copy = deliveryRecordCopy(locale);
    assert(copy.managerCancelPendingNote);
    assert.notEqual(copy.cancelPendingStatus, deliveryStateLabels[locale].cancelled);
  }
});

test("node detail and recovery retain the local intent when receipt delivery IDs change", async () => {
  const local = { id: "local-row", intentId: "local-intent", deliveryId: "manager-before", state: "awaiting_confirmation", source: {}, target: {}, ownerScope: "node" as const };
  const settled = { ...local, id: "local-row-after", deliveryId: "manager-after", state: "cancelled" };
  const reads: any[][] = [];
  const actions: any[][] = [];
  let current = local;
  const { page } = recoveryPage(async (...args) => {
    actions.push(args); current = settled; return settled;
  }, async (...args) => { reads.push(args); return current; });
  await page.showDetails(local);
  page.records.value = [local];
  await page.recover("cancel");
  assert.equal(actions.length, 1);
  assert.equal(actions[0][0], "local-intent");
  assert.equal(actions[0][4], "node-original");
  assert.equal(page.detail.value.deliveryId, "manager-after");
  assert.equal(page.records.value[0].deliveryId, "manager-after");
  assert.match(page.actionNotice.value, /已取消/);
  await page.showDetails(page.detail.value, true);
  assert.deepEqual(reads.map(args => [args[0], args[3]]), [["local-intent", "node-original"], ["local-intent", "node-original"]]);
  assert.equal(deliveryRecordOwnerId({ ...local, intentId: undefined } as any), "local-row");
  assert.equal(deliveryRecordOwnerId({ ...local, ownerScope: "manager" } as any), "manager-before");
});

test("changing computers or closing details ignores late recovery and prevents duplicate commands", async () => {
  for (const exit of ["computer", "close"]) {
    let resolve!: (value: unknown) => void;
    const calls: any[][] = [];
    const { page, route, record } = recoveryPage((...args) => { calls.push(args); return new Promise(done => { resolve = done; }); });
    await page.showDetails(record);
    const pending = page.recover("reconcile");
    await page.recover("cancel");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "original"); assert.equal(calls[0][4], "node-original");
    if (exit === "computer") route.query.nodeId = "node-other";
    else page.detailOpen.value = false;
    await vue.nextTick();
    assert.equal(calls[0][2].aborted, true);
    resolve({ ...record, state: "received" }); await pending;
    assert.equal(page.detail.value.state, "awaiting_confirmation");
    assert.equal(page.actionNotice.value, "");
    assert.equal(page.actionBusy.value, "");
  }
});

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
  assert.equal(deliveryEndpointLabel({ kind: "connection", connection: { managerInstanceId: "manager", transport: "lan-agent", id: "computer-a" } }, "zh-CN"), "computer-a · lan-agent");
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

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { InstanceIdentityResetClient, INSTANCE_IDENTITY_RESET_WAIT_MS, readResetIdentity } from "../src/instanceIdentityResetClient";
import { englishCatalog } from "../src/i18n/catalog";

const operationId = "00000000-0000-4000-8000-000000000001";
const oldGuid = "00000000-0000-4000-8000-000000000002";
const newGuid = "00000000-0000-4000-8000-000000000003";
const endpoint = "/api/rabi/identity/reset-instance-id";
const queued = () => Response.json({ code: 0, data: { operationId, state: "queued" } }, { status: 202 });
const status = (state: string, extra = {}) => Response.json({ code: 0, data: { operationId, state, ...extra } });
const identity = (guid = newGuid) => Response.json({ code: 0, data: { guid, canResetInstanceId: true } });
function client(request: typeof fetch, extra = {}) {
  return new InstanceIdentityResetClient({ request, operationId: () => operationId, ...extra });
}

test("identity support comes from the managed identity DTO, including older unsupported Hosts", async () => {
  const request: typeof fetch = async (path, init) => {
    assert.equal(path, "/api/rabi/identity");
    assert.equal(init?.cache, "no-store");
    return identity(oldGuid);
  };
  assert.deepEqual(await readResetIdentity(new AbortController().signal, request), { guid: oldGuid, canResetInstanceId: true });
  const oldHost: typeof fetch = async () => Response.json({ code: 0, data: { guid: oldGuid } });
  assert.deepEqual(await readResetIdentity(new AbortController().signal, oldHost), { guid: oldGuid, canResetInstanceId: false });
});

test("cancelling confirmation sends no request", async () => {
  let requests = 0;
  const reset = client(async () => { ++requests; throw new Error("Cancellation must not call the Manager"); });
  reset.open(oldGuid);
  reset.cancel();
  await reset.confirm();
  assert.equal(reset.state, "idle");
  assert.equal(reset.dialogOpen, false);
  assert.equal(requests, 0);
});

test("strict confirmed request waits for committed receipt and changed identity; duplicate clicks share one operation", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let entered!: () => void;
  let release!: (response: Response) => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  const reset = client(async (path, init) => {
    calls.push({ path: String(path), init });
    if (path === endpoint) return queued();
    if (path === `${endpoint}/${operationId}`) { entered(); return delayed; }
    assert.equal(path, "/api/rabi/identity");
    return identity();
  });
  reset.open(oldGuid);
  const waiting = reset.confirm();
  await reset.confirm();
  await reached;
  assert.equal(reset.state, "pending", "202 acceptance is not completion");
  assert.equal(reset.newGuid, "");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { operationId, expectedGuid: oldGuid, confirmed: true });
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(calls[0].init?.headers, { "content-type": "application/json" });
  assert.equal(calls[0].init?.redirect, "error");
  release(status("committed", { newGuid }));
  await waiting;
  assert.equal(reset.state, "committed");
  assert.equal(reset.newGuid, newGuid);
  assert.deepEqual(calls.map(call => call.path), [endpoint, `${endpoint}/${operationId}`, "/api/rabi/identity"]);
  assert.ok(calls.every(call => call.init?.signal === calls[0].init?.signal), "POST, event wait and identity readback share one total timeout signal");
});

test("queued operation events are awaited within 45 seconds without a fixed polling interval", async () => {
  let now = 0;
  let reads = 0;
  const reset = client(async (path) => {
    if (path === endpoint) return queued();
    assert.equal(path, `${endpoint}/${operationId}`);
    ++reads;
    now += Math.min(10_000, INSTANCE_IDENTITY_RESET_WAIT_MS - now);
    return status("queued");
  }, { now: () => now, pause: async () => { assert.fail("Normal queued responses must be awaited by the Manager, without a client timer"); } });
  reset.open(oldGuid);
  await reset.confirm();
  assert.equal(INSTANCE_IDENTITY_RESET_WAIT_MS, 45_000);
  assert.equal(now, INSTANCE_IDENTITY_RESET_WAIT_MS);
  assert.equal(reads, 5);
  assert.equal(reset.state, "pending");
  assert.equal(reset.operationId, operationId);
  assert.match(reset.message, /从托盘重新打开/);
  assert.equal(reset.newGuid, "");
});

test("lost submission or unavailable current address remains pending without resubmitting or scanning", async () => {
  for (const submissionLost of [true, false]) {
    const paths: string[] = [];
    const pauses: number[] = [];
    const reset = client(async (path) => {
      paths.push(String(path));
      if (path === endpoint && !submissionLost) return queued();
      throw new TypeError("Current document address is unavailable");
    }, { pause: async (milliseconds: number) => { pauses.push(milliseconds); } });
    reset.open(oldGuid);
    await reset.confirm();
    reset.open(oldGuid);
    await reset.confirm();
    assert.equal(reset.state, "pending");
    assert.equal(reset.newGuid, "");
    assert.equal(paths.filter(path => path === endpoint).length, 1);
    assert.deepEqual(paths, [endpoint, `${endpoint}/${operationId}`, `${endpoint}/${operationId}`]);
    assert.deepEqual(pauses, [500], "A lost read gets only one bounded backoff retry");
    assert.match(reset.message, /结果仍待确认.*托盘/);
  }
});

test("a lost submission receipt can recover only its original operation, without replaying POST", async () => {
  const paths: string[] = [];
  const reset = client(async path => {
    paths.push(String(path));
    if (path === endpoint) throw new TypeError("The accepted POST response was lost");
    return path === "/api/rabi/identity" ? identity() : status("committed", { operationId, newGuid });
  });
  reset.open(oldGuid);
  await reset.confirm();
  assert.equal(reset.state, "committed");
  assert.deepEqual(paths, [endpoint, `${endpoint}/${operationId}`, "/api/rabi/identity"]);
});

test("the operation has one read retry across all waits and bounds an immediate queued server", async () => {
  let reads = 0;
  let pauses = 0;
  const reset = client(async path => {
    if (path === endpoint) return queued();
    ++reads;
    if (reads === 1 || reads === 3) throw new TypeError("Connection interrupted");
    return status("queued");
  }, { pause: async () => { ++pauses; } });
  reset.open(oldGuid);
  await reset.confirm();
  assert.equal(reads, 3);
  assert.equal(pauses, 1);
  assert.equal(reset.state, "pending");

  let immediateReads = 0;
  const immediate = client(async path => path === endpoint ? queued() : (++immediateReads, status("queued")));
  immediate.open(oldGuid);
  await immediate.confirm();
  assert.equal(immediateReads, 5, "A server violating the event-wait contract cannot create an unbounded request loop");
  assert.equal(immediate.state, "pending");
});

test("committed status cannot succeed with the old identity, a mismatched new ID or failed readback", async () => {
  for (const readback of [() => identity(oldGuid), () => identity("another-reset-guid"), () => Response.json({ code: -1 }, { status: 503 })]) {
    const reset = client(async path => path === endpoint ? queued() : path === "/api/rabi/identity" ? readback() : status("committed", { newGuid }));
    reset.open(oldGuid);
    await reset.confirm();
    assert.equal(reset.state, "pending");
    assert.equal(reset.newGuid, "");
  }
});

test("committed receipt requires the exact operation and a valid new GUID", async () => {
  for (const extra of [{ newGuid: undefined }, { newGuid: "invalid" }, { newGuid, operationId: undefined }]) {
    let readbacks = 0;
    const reset = client(async path => {
      if (path === endpoint) return queued();
      if (path === "/api/rabi/identity") { ++readbacks; return identity(); }
      return status("committed", extra);
    });
    reset.open(oldGuid);
    await reset.confirm();
    assert.equal(reset.state, "pending");
    assert.equal(readbacks, 0);
  }
});

test("rolled-back, failed and rejected requests retain their explicit failure messages", async () => {
  for (const state of ["rolled_back", "failed"]) {
    const reset = client(async path => path === endpoint ? queued() : status(state, { message: `Host result: ${state}` }));
    reset.open(oldGuid);
    await reset.confirm();
    assert.equal(reset.state, state);
    assert.equal(reset.message, `Host result: ${state}`);
    assert.equal(reset.newGuid, "");
  }
  const rejected = client(async () => Response.json({ code: -1, message: "Host unsupported" }, { status: 403 }));
  rejected.open(oldGuid);
  await rejected.confirm();
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.message, "Host unsupported");
});

test("a malformed or foreign acceptance receipt never becomes success", async () => {
  let calls = 0;
  const reset = client(async () => { ++calls; return Response.json({ code: 0, data: { operationId: "foreign-operation", state: "queued" } }, { status: 202 }); });
  reset.open(oldGuid);
  await reset.confirm();
  assert.equal(reset.state, "pending");
  assert.equal(calls, 1);
  assert.equal(reset.newGuid, "");
});

test("a foreign operation completion cannot supply a new identity", async () => {
  const paths: string[] = [];
  const reset = client(async path => {
    paths.push(String(path));
    return path === endpoint ? queued() : status("committed", { operationId: "foreign-operation", newGuid });
  });
  reset.open(oldGuid);
  await reset.confirm();
  assert.equal(reset.state, "pending");
  assert.equal(reset.newGuid, "");
  assert.deepEqual(paths, [endpoint, `${endpoint}/${operationId}`]);
});

test("unmount cancels the operation wait and discards late acknowledgements", async () => {
  let release!: (response: Response) => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<Response>(resolve => { release = resolve; });
  let signal: AbortSignal | null | undefined;
  const reset = client(async (path, init) => {
    if (path === endpoint) return queued();
    signal = init?.signal; entered(); return waiting;
  });
  reset.open(oldGuid);
  const operation = reset.confirm();
  await reached;
  reset.dispose();
  assert.equal(signal?.aborted, true);
  release(status("committed", { newGuid }));
  await operation;
  assert.notEqual(reset.state, "committed");
  assert.equal(reset.newGuid, "");
});

test("stopping a wait leaves the Host operation pending and discards its late completion", async () => {
  let entered!: () => void;
  let release!: (response: Response) => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<Response>(resolve => { release = resolve; });
  const paths: string[] = [];
  let signal: AbortSignal | null | undefined;
  const reset = client(async (path, init) => {
    paths.push(String(path));
    if (path === endpoint) return queued();
    signal = init?.signal;
    entered();
    return waiting;
  });
  reset.open(oldGuid);
  const operation = reset.confirm();
  await reached;
  reset.stopWaiting();
  assert.equal(signal?.aborted, true);
  release(status("committed", { newGuid }));
  await operation;
  assert.equal(reset.state, "pending");
  assert.equal(reset.newGuid, "");
  assert.match(reset.message, /从托盘重新打开/);
  assert.deepEqual(paths, [endpoint, `${endpoint}/${operationId}`]);
});

test("the actual confirmation handler updates only the GUID and preserves a dirty Route draft", async () => {
  Object.assign(globalThis, { window: { location: { pathname: "/", hash: "" } } });
  const { useGatewayStore } = await import("../src/stores/gatewayStore");
  setActivePinia(createPinia());
  const store = useGatewayStore();
  store.meta.rabiGuid = oldGuid;
  store.addGateway();
  store.gateways[0].name = "unsaved Route draft";
  const original = JSON.stringify(store.gateways);
  const selected = store.selectedGatewayId;
  const reset = client(async path => path === endpoint ? queued() : path === "/api/rabi/identity" ? identity() : status("committed", { newGuid }));
  reset.open(oldGuid);
  const source = fs.readFileSync(new URL("../src/components/RabiLinkSettings.vue", import.meta.url), "utf8").split('<script setup lang="ts">')[1].split("</script>")[0];
  const parsed = ts.createSourceFile("settings.ts", source, ts.ScriptTarget.ESNext, true);
  const handler = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "confirmReset")!;
  const emitted: boolean[] = [];
  const executable = ts.transpileModule(handler.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const confirm = vm.runInNewContext(`${executable}\nconfirmReset`, {
    reset, store, resetSupported: { value: true }, busy: { value: false }, resetting: { value: false },
    identityRequest: undefined, disposed: false, emit: (_name: string, value: boolean) => emitted.push(value)
  });
  await confirm();
  assert.equal(store.meta.rabiGuid, newGuid);
  assert.equal(JSON.stringify(store.gateways), original);
  assert.equal(store.selectedGatewayId, selected);
  assert.equal(store.dirty, true);
  assert.deepEqual(emitted, [true, false]);
});

test("the UI has explicit confirmation, Host support and bilingual reset guidance", () => {
  const source = fs.readFileSync(new URL("../src/components/RabiLinkSettings.vue", import.meta.url), "utf8");
  assert.match(source, /reset\.open\(store\.meta\.rabiGuid/);
  assert.match(source, /:disabled="!resetSupported/);
  assert.match(source, /@click="reset\.cancel\(\)"/);
  assert.match(source, /@click="reset\.stopWaiting\(\)"/);
  assert.match(source, /旧连接可能需要重新建立/);
  assert.doesNotMatch(source, /store\.load|replaceDirtyConfig/);
  for (const message of ["重置实例 ID", "停止等待", "此操作会生成新的实例 ID 和连接密钥，保留实例名称、人格、记录及连接配置。旧连接可能需要重新建立。", "实例 ID 重置结果仍待确认。页面连接可能已切换，请从托盘重新打开 RabiLink 配置查看结果。", "当前 Host 不支持从页面重置实例 ID。", "重置未完成，请检查 Host 日志与备份。", "重置失败，已恢复原身份。"]) assert.ok(englishCatalog[message]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readNapCatGroupFiles, type GroupFilesPage } from "../napcat.js";
import { verifyQqFileCurrentPresence, type CurrentQqFileBinding, type OriginalQqFileBinding, type QqFileVerificationDependencies } from "./agentDeliveryVerification.js";

const original: OriginalQqFileBinding = { routeId: "route-test", instanceId: "instance-test", groupId: "10001", platformFileId: "file-test", selfId: "20001", bindingRevision: "revision-1" };
function fixture() {
  const binding: CurrentQqFileBinding = { ...original, readAllowed: true, endpoint: { httpUrl: "http://127.0.0.1:12345", accessToken: "fake-token" } };
  let current = binding;
  let account: string | undefined = original.selfId;
  let calls = 0;
  const actions: string[] = [];
  let body: unknown = { status: "ok", retcode: 0, data: { files: [{ file_id: original.platformFileId, file_name: "example.txt" }], folders: [] } };
  const transport: typeof fetch = async (input, init) => {
    calls++;
    const action = new URL(String(input)).pathname;
    actions.push(action);
    assert.ok(["/get_group_root_files", "/get_group_files_by_folder"].includes(action));
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const params = JSON.parse(String(init?.body));
    assert.equal(params.group_id, original.groupId);
    assert.equal(params.file_count, 50);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const dependencies: QqFileVerificationDependencies = {
    readCurrentBinding: () => current,
    readAccountIdentity: async () => account ? { selfId: account } : undefined,
    readFiles: (endpoint, groupId, folderId) => readNapCatGroupFiles(endpoint, groupId, folderId, transport)
  };
  return { dependencies, binding, setBinding: (value: CurrentQqFileBinding) => { current = value; }, setAccount: (value: string | undefined) => { account = value; }, setBody: (value: unknown) => { body = value; }, calls: () => calls, actions };
}
async function verify(dependencies: QqFileVerificationDependencies, expected = original) {
  const result = await verifyQqFileCurrentPresence(expected, dependencies);
  assert.equal(result.deliveredNow, false);
  assert.equal(result.retryAllowed, false);
  assert.equal(result.sha256Verified, false);
  assert.equal(result.captionVerified, false);
  assert.ok(!("absence" in result));
  return result;
}

test("精确 ID 命中仅证明当前存在，假 transport 只执行只读动作", async () => {
  const f = fixture();
  assert.equal((await verify(f.dependencies)).status, "present");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.actions, ["/get_group_root_files"]);
});

test("指定文件夹透传，不按同名异 ID 匹配", async () => {
  const f = fixture();
  f.setBody({ status: "ok", retcode: 0, data: { files: [{ file_id: "different-id", file_name: "example.txt" }], folders: [] } });
  assert.equal((await verify(f.dependencies, { ...original, folderId: "folder-test" })).status, "unknown");
  assert.deepEqual(f.actions, ["/get_group_files_by_folder"]);
});

for (const field of ["routeId", "instanceId", "groupId", "selfId", "bindingRevision"] as const) {
  test(`读前 ${field} 不一致失败关闭，不选择默认实例`, async () => {
    const f = fixture();
    f.setBinding({ ...f.binding, [field]: "different" });
    assert.equal((await verify(f.dependencies)).status, "conflict");
    assert.equal(f.calls(), 0);
  });
}

for (const field of ["routeId", "instanceId", "groupId", "selfId"] as const) {
  test(`读后 ${field} 变化拒绝精确命中证据`, async () => {
    const f = fixture();
    let reads = 0;
    assert.equal((await verify({ ...f.dependencies, readCurrentBinding: () => ++reads === 3 ? { ...f.binding, [field]: "different" } : f.binding })).status, "conflict");
    assert.equal(f.calls(), 1);
  });
}

test("截断列表未命中永远 unknown，不能判 absence", async () => {
  const f = fixture();
  f.setBody({ status: "ok", retcode: 0, data: { files: Array.from({ length: 51 }, (_, i) => ({ file_id: `other-${i}`, file_name: "example.txt" })), folders: [] } });
  assert.equal((await verify(f.dependencies)).reason, "not_observed");
});

for (const stage of ["before", "after"] as const) {
  for (const change of ["revision", "permission", "endpoint"] as const) {
    test(`${stage} 读取围栏拒绝 ${change} 变化，命中不可越权`, async () => {
      const f = fixture();
      let reads = 0;
      const changed: CurrentQqFileBinding = change === "revision" ? { ...f.binding, bindingRevision: "revision-2" }
        : change === "permission" ? { ...f.binding, readAllowed: false }
        : { ...f.binding, endpoint: { ...f.binding.endpoint, accessToken: "fake-changed-token" } };
      const outcome = await verify({ ...f.dependencies, readCurrentBinding: () => ++reads >= (stage === "before" ? 2 : 3) ? changed : f.binding });
      assert.equal(outcome.status, change === "permission" ? "unknown" : "conflict");
      assert.equal(f.calls(), stage === "before" ? 0 : 1);
    });
  }
}

for (const stage of ["before", "after"] as const) {
  for (const value of [undefined, "30001"]) {
    test(`${stage} 缺少账号证据或账号切换不能 present`, async () => {
      const f = fixture();
      let reads = 0;
      const outcome = await verify({ ...f.dependencies, readAccountIdentity: async () => ++reads >= (stage === "before" ? 1 : 2) ? value ? { selfId: value } : undefined : { selfId: original.selfId } });
      assert.equal(outcome.status, value ? "conflict" : "unknown");
      assert.equal(f.calls(), stage === "before" ? 0 : 1);
    });
  }
}

test("无权限、缺绑定、危险 endpoint、缺账号回调均 unknown 且无网络", async () => {
  const f = fixture();
  for (const binding of [undefined, { ...f.binding, readAllowed: false }, { ...f.binding, endpoint: { httpUrl: "https://example.invalid", accessToken: "fixture" } }]) {
    assert.equal((await verify({ ...f.dependencies, readCurrentBinding: () => binding })).status, "unknown");
  }
  assert.equal((await verify({ ...f.dependencies, readAccountIdentity: undefined } as unknown as QqFileVerificationDependencies)).status, "unknown");
  assert.equal(f.calls(), 0);
});

test("endpoint 拒绝凭据 URL、query、hash、非回环、HTTPS 与路径", async () => {
  const f = fixture();
  for (const httpUrl of ["http://user:pass@127.0.0.1:12345", "http://127.0.0.1:12345/?token=fixture", "http://127.0.0.1:12345/#fixture", "http://example.invalid", "https://127.0.0.1:12345", "http://127.0.0.1:12345/action"]) {
    f.setBinding({ ...f.binding, endpoint: { httpUrl, accessToken: "fixture" } });
    assert.equal((await verify(f.dependencies)).reason, "endpoint_unsafe");
  }
  assert.equal(f.calls(), 0);
});

test("异常、畸形响应脱敏，不能泄露 callback 内容", async () => {
  const f = fixture();
  for (const key of ["readCurrentBinding", "readAccountIdentity", "readFiles"] as const) {
    const result = await verify({ ...f.dependencies, [key]: async () => { throw new Error("secret-token private-path upstream-body"); } });
    assert.equal(result.status, "unknown");
    assert.ok(!JSON.stringify(result).includes("secret-token"));
  }
  f.setBody({ status: "failed", retcode: 1, message: "private-body" });
  assert.equal((await verify(f.dependencies)).status, "unknown");
  assert.equal((await verify({ ...f.dependencies, readFiles: async () => ({ files: [{ fileId: original.platformFileId }], folders: [] } as unknown as GroupFilesPage) })).status, "unknown");
});

test("原输入与共享绑定的原地变更不能移动围栏", async () => {
  const f = fixture();
  const input = { ...original };
  const mutable = { ...f.binding, endpoint: { ...f.binding.endpoint } };
  const result = await verify({ ...f.dependencies, readCurrentBinding: () => mutable, readFiles: async (...args) => {
    input.bindingRevision = "revision-2";
    mutable.bindingRevision = "revision-2";
    return f.dependencies.readFiles!(...args);
  } }, input);
  assert.equal(result.status, "conflict");
});

test("挂起只读账号回调在有界期限返回 unknown，不发送或重试", async () => {
  const f = fixture();
  const result = await verify({ ...f.dependencies, readAccountIdentity: async () => new Promise(() => {}) });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "read_failed");
  assert.equal(f.calls(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { readSourceFile } from "./napcatApiSourceFiles.js";

const content = Buffer.from("source-shaped-file");
const route = { id: "example", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "selected", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-secret", botUserId: "12345" }
] } as GatewayDefinition;
const request = { headers: {} } as IncomingMessage;
const base = { routeId: "example", instanceId: "selected" };
const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });

function fixture(kind: "group" | "private") {
  const nativeId = "/native-file-uuid-example";
  const cache = new Map<string, { fileUUID: string; msgId?: string; modelId?: string }>();
  const calls: string[] = [];
  let oldListId = "";
  const list = () => {
    const id = randomUUID().replaceAll("-", "");
    cache.set(id, { modelId: "native-model-id", fileUUID: nativeId });
    oldListId ||= id;
    return { files: [{ file_id: id, file_name: "example.apk.1", file_size: content.length }], folders: [] };
  };
  const context = { route: () => route, local: () => true, transport: async (value: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(value));
    if (url.hostname === "resource.example.invalid") { calls.push("bytes"); return new Response(content); }
    const action = url.pathname.slice(1); calls.push(action);
    const payload = JSON.parse(String(init?.body));
    if (action === "get_login_info") return envelope({ user_id: 12345 });
    if (action === "get_msg") {
      cache.set(nativeId, { msgId: "native-long-message", fileUUID: nativeId });
      return envelope({ post_type: "message", message_type: kind, message_id: 12, self_id: 12345,
        user_id: 456, ...(kind === "group" ? { group_id: 789 } : {}),
        message: [{ type: "file", data: { file: "example.apk", file_id: nativeId, file_size: String(content.length) } }] });
    }
    if (action === "get_group_root_files") return envelope(list());
    if (action === "get_group_file_url" || action === "get_private_file_url") {
      if (!cache.get(payload.file_id)?.fileUUID) return Response.json({ status: "failed", retcode: 1200, wording: "example-private-upstream-detail" });
      if (action === "get_private_file_url") assert.ok(cache.get(payload.file_id)?.msgId);
      else assert.equal(payload.group_id, "789");
      return envelope({ url: "https://resource.example.invalid/file?token=example-private-value" });
    }
    throw Error(`Unexpected source-shaped action ${action}`);
  } };
  return { context, list, calls, expire: () => cache.clear(), previousId: () => oldListId };
}

for (const kind of ["group", "private"] as const) test(`${kind} exact source uses converter-cached slash UUID through fixed native URL action`, async () => {
  const f = fixture(kind);
  const result = await readSourceFile(f.context, request, { ...base, source: { kind, targetId: kind === "group" ? "789" : "456", messageId: "12", attachmentIndex: 0 } }, AbortSignal.timeout(1000));
  assert.deepEqual(result.bytes, content);
  assert.ok(f.calls.includes(kind === "group" ? "get_group_file_url" : "get_private_file_url"));
  assert.equal(f.calls.includes("get_file"), false);
  assert.equal(JSON.stringify(result).includes("example-private-value"), false);
});

test("expired native group reference fails safely without picking another file or replaying", async () => {
  const f = fixture("group"); f.list(); f.expire();
  await assert.rejects(readSourceFile(f.context, request, { ...base, group: { groupId: "789", fileId: f.previousId() } }, AbortSignal.timeout(1000)), error => {
    assert.equal((error as { code: string }).code, "QQ_UPSTREAM_UNAVAILABLE");
    assert.equal(String(error).includes("example-private-upstream-detail"), false);
    return true;
  });
  assert.equal(f.calls.filter(action => action === "get_group_file_url").length, 1);
  assert.equal(f.calls.includes("get_group_root_files"), false);
  assert.equal(f.calls.includes("bytes"), false);
});

test("original GroupFS cache reference resolves without re-listing or assuming an original filename", async () => {
  const f = fixture("group");
  f.list();
  const result = await readSourceFile(f.context, request, { ...base, group: { groupId: "789", fileId: f.previousId() } }, AbortSignal.timeout(1000));
  assert.deepEqual(result.bytes, content);
  assert.equal(result.name, "group-file.bin");
  assert.equal(f.calls.includes("get_group_file_url"), true);
  assert.equal(f.calls.includes("get_group_root_files"), false);
  assert.equal(f.calls.includes("get_file"), false);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type IncomingMessage } from "node:http";
import test from "node:test";
import { compileApiContract, readApiOperationInput, validateApiOperationResult, type ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createSourceFileOperations } from "./napcatApiSourceFileOperations.js";
import { readQqMedia } from "./qqMessageMedia.js";
import { readNapCatGroupFiles } from "../napcat.js";

const bytes = Buffer.from("example-http-file-bytes");
const nativeUrl = "https://media.example.invalid/file?token=example-private-secret";
const privateBody = { routeId: "example", instanceId: "example-instance", source: { kind: "private", targetId: "456", messageId: "12", attachmentIndex: 0 } };
const groupBody = { routeId: "example", instanceId: "example-instance", group: { groupId: "789", fileId: "0123456789abcdef0123456789abcdef" } };
const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
function input(body: unknown): ApiOperationInput {
  return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://127.0.0.1/example"), body, path: {}, query: {} } as ApiOperationInput;
}
function fixture() {
  const route = { id: "example", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
    { id: "example-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-token", botUserId: "12345" }
  ] } as GatewayDefinition;
  const state = { actualQQ: 12345, switchAfterBytes: false, nativeFile: "", urlAvailable: true, groupMessage: false, filePresent: true, fileName: "example.bin",
    content: bytes, mediaStatus: 200, declaredSize: -1 };
  const calls: string[] = [];
  const context = { route: () => route, local: () => true, transport: async (value: RequestInfo | URL) => {
    const url = new URL(String(value));
    if (url.hostname === "media.example.invalid") {
      calls.push("binary");
      if (state.switchAfterBytes) state.actualQQ = 99999;
      return new Response(state.mediaStatus === 200 ? state.content : "example-private-error-page", { status: state.mediaStatus });
    }
    const action = url.pathname.slice(1); calls.push(action);
    if (action === "get_login_info") return envelope({ user_id: state.actualQQ });
    if (action === "get_msg") return envelope({ post_type: "message", message_type: state.groupMessage ? "group" : "private", self_id: 12345,
      ...(state.groupMessage ? { group_id: 789 } : {}), user_id: 456, message_id: 12,
      message: [{ type: "file", data: { file_id: "example-file-id", file_name: state.fileName } }] });
    if (action === "get_group_root_files") return envelope({ files: state.filePresent ? [{ file_id: "example-file-id", file_name: "../private/example.bin", file_size: state.content.length }] : [], folders: [] });
    if (action === "get_group_file_url" || action === "get_private_file_url") return envelope(state.urlAvailable ? { url: nativeUrl } : {});
    if (action === "get_file") return envelope({ ...(state.nativeFile ? { file: state.nativeFile } : {}), ...(state.urlAvailable ? { url: nativeUrl } : {}), file_size: state.declaredSize < 0 ? state.content.length : state.declaredSize });
    throw Error(`Unexpected fixture action ${action}`);
  } };
  return { context, route, state, calls };
}

test("two fixed closed binary contracts retain six aliases and advertise their exact view", () => {
  const f = fixture(), operations = createSourceFileOperations(f.context);
  assert.equal(operations.length, 3);
  assert.equal(operations.flatMap(row => [row.contract.operationId, ...(row.contract.aliases ?? [])]).length, 7);
  for (const row of operations.slice(0, 2)) {
    compileApiContract({ contract: row.contract });
    assert.match(row.contract.description, /nativeContractEquivalent=false/);
    assert.equal(row.contract.responses["200"].mediaType, "application/octet-stream");
    assert.equal(row.contract.operationId.includes("stream"), false);
  }
});

test("each exact source completes original-owner bytes and checks actual QQ again after bytes", async () => {
  for (const [index, body] of [privateBody, groupBody].entries()) {
    const f = fixture(), operation = createSourceFileOperations(f.context)[index]!;
    const result = await operation.handler(input(body));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, bytes);
    assert.equal(result.headers?.["x-rabiroute-native-contract-equivalent"], "false");
    assert.equal(JSON.stringify(result.headers).includes("private-secret"), false);
    assert.equal(JSON.stringify(result.headers).includes("../private/"), false);
    assert.equal(f.calls.filter(action => action === "get_login_info").length, 2);
    assert.equal(f.calls.at(-1), "get_login_info");
    validateApiOperationResult(compileApiContract({ contract: operation.contract }), result);
  }
});

test("a native client account switch during byte retrieval returns no success bytes", async () => {
  const f = fixture(); f.state.switchAfterBytes = true;
  const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: -1, errorCode: "QQ_API_ACCOUNT_MISMATCH" });
  assert.equal(f.calls.filter(action => action === "get_login_info").length, 2);
});

test("source filenames use RFC5987 escaping in binary download headers", async () => {
  const f = fixture(); f.state.fileName = "Example's (1)*.bin";
  const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
  assert.equal(result.status, 200);
  assert.equal(result.headers?.["content-disposition"], "attachment; filename*=UTF-8''Example%27s%20%281%29%2A.bin");
});

test("long Unicode and a truncated emoji produce decodable well-formed filename headers", async () => {
  for (const [name, expected] of [["文".repeat(210) + ".bin", "文".repeat(200)], ["a".repeat(199) + "😀.bin", "a".repeat(199) + "\uFFFD"]]) {
    const f = fixture(); f.state.fileName = name!;
    const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, bytes);
    const header = String(result.headers?.["content-disposition"]);
    assert.equal(decodeURIComponent(header.split("UTF-8''")[1]!), expected);
  }
});

test("the existing bounded media owner rejects HTTP error pages for legacy and new reads", async () => {
  for (const status of [403, 404]) {
    const f = fixture(); f.state.mediaStatus = status;
    const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
    assert.deepEqual(result.body, { code: -1, errorCode: "QQ_UPSTREAM_UNAVAILABLE" });
    assert.equal(result.status, 503);
    assert.equal(JSON.stringify(result).includes("example-private-error-page"), false);
    assert.equal(JSON.stringify(result).includes("private-secret"), false);
    for (const kind of ["file", "image"] as const) {
      await assert.rejects(readQqMedia({ httpUrl: "http://127.0.0.1:12345", accessToken: "example-token" },
        { kind, name: "example.bin", file: "example-file-id", url: nativeUrl }, AbortSignal.timeout(1000), f.context.transport),
      { status: 503, code: "QQ_UPSTREAM_UNAVAILABLE" });
    }
  }
});

test("only explicitly enabled file views accept legitimate empty bytes and their empty SHA256", async t => {
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const f = fixture(); f.state.content = Buffer.alloc(0);
  const operations = createSourceFileOperations(f.context);
  for (const [index, body] of [privateBody, groupBody].entries()) {
    const result = await operations[index]!.handler(input(body));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, Buffer.alloc(0));
    assert.equal(result.headers?.["content-length"], "0");
    assert.equal(result.headers?.["x-rabiroute-content-sha256"], emptyHash);
    validateApiOperationResult(compileApiContract({ contract: operations[index]!.contract }), result);
  }
  const endpoint = { httpUrl: "http://127.0.0.1:12345", accessToken: "example-token" };
  await assert.rejects(readQqMedia(endpoint, { kind: "file", name: "example.bin", file: "example-file-id" }, AbortSignal.timeout(1000), f.context.transport), { code: "QQ_MEDIA_EMPTY" });
  for (const kind of ["image", "audio"] as const) await assert.rejects(readQqMedia(endpoint,
    { kind, name: "example.bin", file: "example-file-id", url: nativeUrl }, AbortSignal.timeout(1000), f.context.transport,
    { mode: "url-only", allowEmptyFile: true }), { code: "QQ_MEDIA_EMPTY" });
  f.state.declaredSize = 1;
  await assert.rejects(readQqMedia(endpoint, { kind: "file", name: "empty.bin", file: "example-file-id" }, AbortSignal.timeout(1000), f.context.transport, { mode: "url-only", allowEmptyFile: true }), { code: "QQ_MEDIA_EMPTY" });
  const ownedDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-empty-legacy-"));
  t.after(() => fs.rm(ownedDir, { recursive: true, force: true }));
  const ownedFile = path.join(ownedDir, "empty.bin"); await fs.writeFile(ownedFile, Buffer.alloc(0));
  const local: typeof fetch = async () => envelope({ file: ownedFile, file_size: 0 });
  await assert.rejects(readQqMedia(endpoint, { kind: "file", name: "empty.bin", file: "example-file-id" }, AbortSignal.timeout(1000), local), { code: "QQ_MEDIA_EMPTY" });
});

test("original caller revocation and Route rebinding after bytes prevent disclosure", async () => {
  for (const mutation of ["permission", "binding"] as const) {
    const f = fixture(); let authorized = true;
    f.context.local = () => authorized;
    const transport = f.context.transport;
    f.context.transport = async value => {
      const response = await transport(value);
      if (new URL(String(value)).hostname === "media.example.invalid") {
        if (mutation === "permission") authorized = false;
        else f.route.napcatInstances![0]!.accessToken = "example-new-token";
      }
      return response;
    };
    const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
    assert.equal(result.status, mutation === "permission" ? 403 : 409);
    assert.equal(result.body instanceof Uint8Array, false);
  }
});

test("new URL-only mode preserves the legacy default and never infers local access from hostname", async t => {
  const ownedDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-url-only-owner-"));
  t.after(() => fs.rm(ownedDir, { recursive: true, force: true }));
  const ownedFile = path.join(ownedDir, "example-local-file.bin");
  await fs.writeFile(ownedFile, "example-local-owner-bytes");
  const legacyTransport: typeof fetch = async () => envelope({ file: ownedFile });
  assert.equal((await readQqMedia({ httpUrl: "http://127.0.0.1:12345", accessToken: "example-token" },
    { kind: "file", name: "example.bin", file: "example-file-id" }, AbortSignal.timeout(1000), legacyTransport)).toString(), "example-local-owner-bytes");
  for (const origin of ["http://127.0.0.1:12345", "http://native.example.invalid:12345"]) {
    const f = fixture();
    f.route.napcatInstances![0]!.httpUrl = origin;
    f.state.nativeFile = ownedFile; f.state.urlAvailable = false;
    const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
    assert.equal(result.status, 422);
    assert.deepEqual(result.body, { code: -1, errorCode: "QQ_MEDIA_REFERENCE_UNAVAILABLE" });
    assert.equal(JSON.stringify(result.body).includes(ownedFile), false);
  }
  const f = fixture(); f.state.nativeFile = ownedFile;
  const result = await createSourceFileOperations(f.context)[0]!.handler(input(privateBody));
  assert.deepEqual(result.body, bytes);
});

test("private/group source shapes reject mixing, native raw file IDs and caller paths before provider access", async () => {
  const f = fixture(), operations = createSourceFileOperations(f.context);
  for (const body of [{ ...privateBody, path: "C:/private/example.bin" }, { ...privateBody, url: nativeUrl },
    { ...privateBody, source: { ...privateBody.source, kind: "group" } }, { routeId: "example", instanceId: "example-instance", params: { file_id: "unproven" } }]) {
    assert.equal((await operations[0]!.handler(input(body))).status, 400);
  }
  assert.equal((await operations[1]!.handler(input({ ...groupBody, source: { ...privateBody.source, kind: "group", targetId: "789" } }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("group source keeps original message access separate from configured group-file-list policy", async () => {
  const f = fixture(); f.state.groupMessage = true;
  f.route.messageAdapterPolicies = { napcat: { readableGroupFileIds: ["999"] } };
  const operation = createSourceFileOperations(f.context)[1]!;
  const byMessage = await operation.handler(input({ ...privateBody, source: { ...privateBody.source, kind: "group", targetId: "789" } }));
  assert.equal(byMessage.status, 200);
  const byList = await operation.handler(input(groupBody));
  assert.equal(byList.status, 403);
  assert.equal(f.calls.includes("get_group_member_list"), false);
});

test("group metadata owner keeps the original four-argument timeout-backed call", async () => {
  let signal: AbortSignal | null | undefined;
  const transport: typeof fetch = async (_url, init) => { signal = init?.signal; return envelope({ files: [], folders: [] }); };
  const page = await readNapCatGroupFiles({ httpUrl: "http://127.0.0.1:12345", accessToken: "example-token" }, "789", undefined, transport);
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal?.aborted, false);
  assert.deepEqual(page.files, []);
  assert.equal(page.completenessUnknown, true);
});

test("caller cancellation reaches the fixed native URL provider before the owner deadline", async () => {
  const f = fixture(), controller = new AbortController();
  const transport = f.context.transport;
  let entered!: () => void;
  const providerStarted = new Promise<void>(resolve => { entered = resolve; });
  let observedAbort = false;
  f.context.transport = async (value, init?: RequestInit) => {
    if (new URL(String(value)).pathname !== "/get_group_file_url") return transport(value);
    const signal = init?.signal; assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { observedAbort = true; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      entered();
    });
  };
  const pending = createSourceFileOperations(f.context)[1]!.handler({ ...input(groupBody), signal: controller.signal });
  await providerStarted;
  controller.abort();
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(Error("Caller abort did not reach group metadata")), 500);
    })]);
    assert.equal(observedAbort, true);
    assert.equal(result.status, 503);
    assert.equal(f.calls.includes("get_file"), false);
  } finally { clearTimeout(timeout); }
});

test("the standard API reader and validator serve real isolated HTTP binary responses", async t => {
  const f = fixture(), operations = createSourceFileOperations(f.context);
  const server = http.createServer(async (request, response) => {
    const operation = operations.find(row => row.contract.pathTemplate === request.url);
    if (!operation) { response.writeHead(404).end(); return; }
    const compiled = compileApiContract({ contract: operation.contract });
    try {
      const parsed = await readApiOperationInput(compiled, request, new URL(request.url!, "http://127.0.0.1"), response);
      const result = await operation.handler(parsed);
      validateApiOperationResult(compiled, result);
      response.writeHead(result.status, result.headers);
      response.end(result.body instanceof Uint8Array ? result.body : JSON.stringify(result.body));
    } catch { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: -1, errorCode: "FIXTURE_CONTRACT_REJECTED" })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  for (const empty of [false, true]) for (const [index, body] of [privateBody, groupBody].entries()) {
    f.state.content = empty ? Buffer.alloc(0) : bytes;
    const response: Response = await fetch(`http://127.0.0.1:${address.port}${operations[index]!.contract.pathTemplate}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("x-rabiroute-native-contract-equivalent"), "false");
    assert.equal(response.headers.get("content-length"), String(f.state.content.length));
    if (empty) assert.equal(response.headers.get("x-rabiroute-content-sha256"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.state.content);
  }
});

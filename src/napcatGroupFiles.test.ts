import assert from "node:assert/strict";
import test from "node:test";
import { parseNapCatGroupFiles, readNapCatGroupFiles } from "./napcat.js";

const file = { file_id: "file_1", file_name: "sample.txt", file_size: 12, upload_time: 100, uploader: 123, busid: 102 };
const folder = { folder_id: "folder_1", folder_name: "Folder", total_file_count: 7 };

test("projects only bounded metadata and never claims a complete directory", () => {
  const page = parseNapCatGroupFiles({ status: "ok", retcode: 0, data: { files: [file, { ...file, file_name: "x".repeat(300) }], folders: [folder] } });
  assert.deepEqual(page.files, [{ fileId: "file_1", fileName: "sample.txt", fileSize: 12, uploadTime: 100, uploader: "123", busid: 102 }]);
  assert.deepEqual(page.folders, [{ folderId: "folder_1", folderName: "Folder", totalFileCount: 7 }]);
  assert.equal(page.completenessUnknown, true);
  assert.equal(page.potentiallyTruncated, true);
  assert.equal(page.projectionTruncated, false);
  assert.equal(parseNapCatGroupFiles({ status: "ok", retcode: 0, data: { files: Array(51).fill(file), folders: [] } }).projectionTruncated, true);
  assert.equal(parseNapCatGroupFiles({ status: "ok", retcode: 0, data: { files: Array(51).fill(file), folders: [] } }).files.length, 50);
  const mixed = parseNapCatGroupFiles({ status: "ok", retcode: 0, data: { files: Array(30).fill(file), folders: Array(30).fill(folder) } });
  assert.equal(mixed.files.length + mixed.folders.length, 50);
  assert.equal(mixed.projectionTruncated, true);
  assert.throws(() => parseNapCatGroupFiles({ status: "failed", retcode: 1, data: { files: [], folders: [] } }));
  assert.throws(() => parseNapCatGroupFiles({ status: "ok", retcode: 0, data: { files: [] } }));
});

test("read actions use fixed names, folder_id and file_count with no download or upload", async () => {
  const actions: { url: string; body: any; init: RequestInit }[] = [];
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    actions.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init! });
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { files: [file], folders: [] } }), { status: 200 });
  };
  const endpoint = { httpUrl: "http://127.0.0.1:3000", accessToken: "fake-token" };
  await readNapCatGroupFiles(endpoint, "123456", undefined, transport as typeof fetch);
  await readNapCatGroupFiles(endpoint, "123456", "folder_1", transport as typeof fetch);
  assert.match(actions[0]!.url, /\/get_group_root_files$/);
  assert.deepEqual(actions[0]!.body, { group_id: "123456", file_count: 50 });
  assert.match(actions[1]!.url, /\/get_group_files_by_folder$/);
  assert.deepEqual(actions[1]!.body, { group_id: "123456", folder_id: "folder_1", file_count: 50 });
  assert.equal(actions[0]!.init.redirect, "error");
});

test("rejects oversized streamed responses, HTTP errors and upstream timeout", async () => {
  const endpoint = { httpUrl: "http://127.0.0.1:3000", accessToken: "fake-token" };
  await assert.rejects(readNapCatGroupFiles(endpoint, "123456", undefined, (async () => new Response("x".repeat(300_000))) as typeof fetch));
  await assert.rejects(readNapCatGroupFiles(endpoint, "123456", undefined, (async () => new Response("secret upstream", { status: 500 })) as typeof fetch));
  await assert.rejects(readNapCatGroupFiles(endpoint, "123456", undefined, (async (_url, init) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    throw new Error("unreachable");
  }) as typeof fetch));
});

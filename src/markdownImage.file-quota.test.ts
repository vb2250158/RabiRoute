import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { renderMarkdownFileToPngPages } from "./markdownImage.js";

function fixture(t: TestContext, reference: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-markdown-file-quota-"));
  const file = path.join(root, "fixture.md");
  fs.writeFileSync(file, `![fixture](${reference})`);
  const old = process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES;
  t.after(() => {
    if (old === undefined) delete process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES;
    else process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file };
}

test("Markdown attachment rejects the existing source quota before remote image I/O", async t => {
  const { file } = fixture(t, "https://fixture.invalid/image.png");
  process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES = "1";
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("resource fetch must not start"); });
  await assert.rejects(renderMarkdownFileToPngPages(file), /RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES=1 exceeded/);
  assert.equal(fetches, 0);
});

test("Markdown attachment rejects the existing source quota before local image I/O", async t => {
  const { root, file } = fixture(t, "./image.png");
  process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES = "1";
  const reads = t.mock.method(fs.promises, "readFile");
  await assert.rejects(renderMarkdownFileToPngPages(file), /RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES=1 exceeded/);
  assert.equal(reads.mock.calls.some(call => path.resolve(String(call.arguments[0])) === path.join(root, "image.png")), false);
});

test("Markdown valid, zero and unset quotas retain the original resource error", async t => {
  const { file } = fixture(t, "https://fixture.invalid/image.png");
  const original = new Error("original resource failure");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw original; });
  for (const quota of ["1024", "0", undefined]) {
    if (quota === undefined) delete process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES;
    else process.env.RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES = quota;
    await assert.rejects(renderMarkdownFileToPngPages(file), error => error === original);
  }
  assert.equal(fetches, 3);
});

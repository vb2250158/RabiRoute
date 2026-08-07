import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import { handlePersonaDocumentApi } from "./personaDocumentRoutes.js";

class MockResponse extends Writable {
  statusCode = 0;
  headers: http.OutgoingHttpHeaders = {};
  readonly chunks: Buffer[] = [];

  writeHead(statusCode: number, headers: http.OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function requestDocument(url: string, roleDir: string): Promise<MockResponse> {
  const request = { method: "GET" } as http.IncomingMessage;
  const response = new MockResponse();
  const finished = once(response, "finish");
  assert.equal(handlePersonaDocumentApi(
    request,
    new URL(url, "http://127.0.0.1"),
    response as unknown as http.ServerResponse,
    () => roleDir
  ), true);
  await finished;
  return response;
}

test("serves one bounded Markdown file from the selected role", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-document-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi\n\n正文", "utf8");
  const response = await requestDocument("/api/roles/Rabi/persona-document?file=persona.md", roleDir);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(response.body(), "# Rabi\n\n正文");
});

test("rejects paths and non-Markdown files", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-document-"));
  const traversal = await requestDocument("/api/roles/Rabi/persona-document?file=..%2Fsecret.md", roleDir);
  const extension = await requestDocument("/api/roles/Rabi/persona-document?file=secret.txt", roleDir);
  assert.equal(traversal.statusCode, 400);
  assert.equal(extension.statusCode, 400);
});

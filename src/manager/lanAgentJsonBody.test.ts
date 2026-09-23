import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";

// Exercise the actual reader without importing the Manager startup/lifecycle module.
const source = fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
const reader = source.slice(source.indexOf("function readJsonBody<T>"), source.indexOf("function singleRequestHeader"));
const javascript = ts.transpileModule(reader, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("remote JSON bodies retain their bounded ceiling and stricter explicit limits",  async () => {
  for (const remote of [false, true]) {
    let validations = 0;
    const read = vm.runInNewContext(`${javascript}; readJsonBody`, {
      Buffer, hasLanAgentBodyGuard: () => remote,
      validateLanAgentRequestBody: () => { validations++; }
    }) as (request: PassThrough, maxBytes?: number) => Promise<{ text: string }>;
    const body = { text: "x".repeat(1024 * 1024 + 1) };
    const request = new PassThrough();
    const result = read(request);
    request.end(JSON.stringify(body));
    if (remote) await assert.rejects(result, /Request body exceeds 1048576 bytes/);
    else assert.deepEqual((await result).text, body.text);
    assert.equal(validations, remote ? 0 : 1);
    const bounded = new PassThrough();
    const failure = read(bounded, 16);
    bounded.end(JSON.stringify(body));
    await assert.rejects(failure, /Request body exceeds 16 bytes/);
    assert.equal(validations, remote ? 0 : 1);
  }
});

test("catalog-external Agent requests retain explicit admin-token gate before handlers", () => {
  const gate = source.indexOf("const managementAccessAllowed");
  assert.ok(gate > 0);
  const section = source.slice(gate, source.indexOf("if (managerReadOnly", gate));
  assert.match(section, /requiresManagementAuth \|\| webguiTokenMatches/);
  assert.match(section, /if \(!managementAccessAllowed\)/);
  assert.match(section, /WEBGUI_TOKEN_REQUIRED/);
});

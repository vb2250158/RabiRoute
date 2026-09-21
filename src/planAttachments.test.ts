import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { planAttachmentDirectory, resolvePlanAttachmentFile } from "./planAttachments.js";
import type { PlanAttachment } from "./shared/planAttachmentContract.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-attachment-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "roles", "FixtureRole");
  const planId = "fixture-plan";
  const active = planAttachmentDirectory(roleDir, planId, "active");
  const archive = planAttachmentDirectory(roleDir, planId, "archive");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  return { root, roleDir, planId, active, archive };
}

function attachment(file: string, content = "fixture content"): PlanAttachment {
  return { id: "fixture-attachment", kind: "file", name: path.basename(file), path: file,
    size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), mimeType: "text/plain" };
}

test("attachment owner returns canonical regular files from the same active or archive roots", t => {
  const f = fixture(t);
  for (const directory of [f.active, f.archive]) {
    const file = path.join(directory, "fixture.txt");
    fs.writeFileSync(file, "fixture content");
    assert.equal(resolvePlanAttachmentFile(f.roleDir, f.planId, attachment(file)), fs.realpathSync(file));
  }
});

test("attachment owner rejects external entries and directories instead of returning them", t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside.txt");
  fs.writeFileSync(outside, "fixture content");
  assert.throws(() => resolvePlanAttachmentFile(f.roleDir, f.planId, attachment(outside)), /unavailable in its managed directories/);
  const directory = path.join(f.active, "not-a-file");
  fs.mkdirSync(directory);
  assert.throws(() => resolvePlanAttachmentFile(f.roleDir, f.planId, attachment(directory)), /unavailable in its managed directories/);
});

test("attachment owner rejects a managed child directory junction that escapes to an external entry", t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "escaped.txt"), "fixture content");
  const junction = path.join(f.active, "linked-child");
  fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolvePlanAttachmentFile(f.roleDir, f.planId, attachment(path.join(junction, "escaped.txt"))), /unavailable in its managed directories/);
});

test("attachment relocation still verifies metadata before accepting the archived file", t => {
  const f = fixture(t);
  const previous = path.join(f.active, "relocated.txt");
  const current = path.join(f.archive, "relocated.txt");
  const metadata = attachment(previous);
  fs.writeFileSync(current, "fixture content");
  assert.equal(resolvePlanAttachmentFile(f.roleDir, f.planId, metadata), fs.realpathSync(current));
  fs.writeFileSync(current, "changed content");
  assert.throws(() => resolvePlanAttachmentFile(f.roleDir, f.planId, metadata), /unavailable in its managed directories/);
});

test("the actual Manager send caller passes the same identity and forwards the owner's canonical result", () => {
  const text = fs.readFileSync(new URL("./manager/controlPlaneRoutes.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("controlPlaneRoutes.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let caller: ts.FunctionDeclaration | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "resolveSendManagedPlanAttachment") caller = node;
    ts.forEachChild(node, find);
  };
  find(source);
  assert.ok(caller?.body);
  const body = caller.body;
  const calls: ts.CallExpression[] = [];
  let result: ts.VariableDeclaration | undefined;
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "realFile") result = node;
    ts.forEachChild(node, inspect);
  };
  inspect(body);
  const resolveCalls = calls.filter(call => call.expression.getText(source) === "resolvePlanAttachmentFile");
  assert.equal(resolveCalls.length, 1);
  assert.equal(result?.initializer, resolveCalls[0]);
  assert.deepEqual(resolveCalls[0]!.arguments.map(arg => arg.getText(source)), ["roleDir", "plan.id", "attachment"]);
  assert.ok(!calls.some(call => call.expression.getText(source).startsWith("fs.")), "parent must not repeat the storage owner's I/O");
  const send = calls.find(call => call.expression.getText(source) === "send");
  assert.ok(send && ts.isObjectLiteralExpression(send.arguments[0]!));
  const values = Object.fromEntries(send.arguments[0].properties.filter(ts.isPropertyAssignment)
    .map(property => [property.name.getText(source), property.initializer.getText(source)]));
  assert.deepEqual(values, { path: "realFile", fileName: "attachment.name" });
  const callerText = body.getText(source);
  assert.match(callerText, /sanitizeRoleId\(reference\.roleId \?\? ""\)/);
  assert.match(callerText, /roleDirForApi\(roleId\)/);
  assert.match(callerText, /getPlan\(roleDir, reference\.planId\)/);
  assert.match(callerText, /item\.id === reference\.attachmentId/);
  assert.match(callerText, /attachment\.kind !== "image" && attachment\.kind !== "file"/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import test, { type TestContext } from "node:test";
import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import {
  assertMessageProcessingReadBudget,
  readMessageProcessingProjection,
  type MessageProcessingReadInput,
  type MessageProcessingReadProjection
} from "./messageProcessingReadProjection.js";

const BYTE_LIMIT = 1_048_576;
const conversationKey = "napcat:gateway:route-main:instance:qq-main:group:100200301";

// Reuse the public synthetic source/image evidence shape from sourceContextRecovery.test.ts.
// That file registers tests on import, so keep the fixture local rather than importing it.
function fixture(t: TestContext, recentCount = 0) {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-processing-projection-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const archiveDir = path.join(roleDir, "conversation", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const imagePath = path.join(roleDir, "napcat-media", "qq-main", "source-old", "01-image.png");
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50]));
  const attachment = {
    id: "source-old:image:1", kind: "image", name: "01-image.png", status: "ready",
    path: imagePath, sourceMessageId: "source-old"
  };
  const formalRecord = {
    time: 1, groupId: 100200301, userId: 10001,
    rawMessage: `[CQ:image,file=01-image.png] 完整来源 ${"原文🙂".repeat(7000)}`,
    messageId: "source-old", senderName: "user-1", instanceId: "qq-main", adapterType: "napcat",
    isSelf: false, attachments: [attachment], extraEvidence: { marker: "source-tail" }
  };
  const requirement: MessageProcessingRequirement = {
    id: "requirement-source-recovery", dedupeKey: "message-group:requirement-source-recovery",
    kind: "message_reply", replyPolicy: "required", status: "awaiting_send",
    source: {
      routeId: "route-main", routeProfileId: "route-main", roleId: "RoleMain", endpoint: "napcat",
      conversationKey, sender: "user-1", routeKinds: ["group_message"], messageIds: ["source-old"],
      replyContext: { runtimeRouteId: "route-main", gatewayId: "route-main", routeProfileId: "route-main",
        groupId: 100200301, instanceId: "qq-main" },
      attachments: [{ id: attachment.id, messageId: "source-old", kind: "image", name: attachment.name,
        status: "ready", path: imagePath }]
    },
    sourceEvidenceReview: {
      reviewedMessageIds: ["source-old"], replyChainChecked: true,
      attachmentReviews: [{ attachmentId: attachment.id, status: "reviewed", observation: "已核对合成附件" }],
      evidence: "已核对合成来源消息", reviewedAt: "2026-08-14T02:00:00.000Z"
    },
    messageGroupId: "message-group-b4f8", createdAt: "2026-08-14T01:55:03.569Z",
    updatedAt: "2026-08-14T01:55:03.569Z", dueAt: "2026-08-14T02:05:03.569Z"
  };
  const groupFile = path.join(roleDir, "group-messages.jsonl");
  fs.writeFileSync(groupFile, `${JSON.stringify(formalRecord)}\n`);
  const currentFile = path.join(roleDir, "conversation", "current.jsonl");
  const context = (sequence: number, key = conversationKey) => ({
    schemaVersion: 1, id: `synthetic-${sequence}`, sequence, time: sequence + 2,
    recordedAt: "2026-08-14T02:00:00.000Z", direction: "inbound", adapter: "napcat", channel: "napcat",
    conversationKey: key, sender: "user-2", target: "100200301", text: `recent-${sequence}`,
    messageId: `recent-${sequence}`
  });
  fs.writeFileSync(currentFile, Array.from({ length: recentCount }, (_, i) => JSON.stringify(context(i + 2))).join("\n"));
  const archiveFile = path.join(archiveDir, "1~1.jsonl");
  fs.writeFileSync(archiveFile, `${JSON.stringify(context(1, "other-conversation"))}\n`);
  const indexFile = path.join(archiveDir, "index.json");
  fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 1, nextSequence: recentCount + 2,
    archives: [{ file: "1~1.jsonl", startedAt: "2026-08-14T02:00:00.000Z", endedAt: "2026-08-14T02:00:00.000Z",
      entryCount: 1, firstSequence: 1, lastSequence: 1 }] }));
  const legacyFile = path.join(roleDir, "message-context.jsonl");
  fs.writeFileSync(legacyFile, "");
  const input: MessageProcessingReadInput = {
    roleDir, requirement, sourceMessageId: "source-old",
    reviewedSource: { expectedGroupId: "100200301", expectedInstanceId: "qq-main" }
  };
  return { input, formalRecord, groupFile, currentFile, archiveFile, archiveDir, indexFile, legacyFile };
}

function assertCompleteSource(projection: MessageProcessingReadProjection, data: ReturnType<typeof fixture>) {
  assert.ok(projection.reviewedSource);
  assert.deepEqual(projection.reviewedSource.record, data.formalRecord);
  assert.equal(projection.reviewedSource.contextRecord.text, data.formalRecord.rawMessage);
  assert.deepEqual(projection.reviewedSource.reviewedAttachmentIds, ["source-old:image:1"]);
  // Normalized context intentionally exposes safe metadata; full paths remain in formal evidence.
  assert.equal(projection.reviewedSource.contextRecord.attachments?.[0]?.id, data.formalRecord.attachments[0]!.id);
  assert.deepEqual(projection.reviewedSource.record.attachments, data.formalRecord.attachments);
  const source = projection.records.filter(item => item.messageId === "source-old");
  assert.equal(source.length, 1);
  assert.equal(source[0]!.text, data.formalRecord.rawMessage);
}

test("81 records including the recovered full source are accepted; 82 are rejected without mutation", t => {
  const data = fixture(t, 80);
  const projection = readMessageProcessingProjection(data.input);
  assert.equal(projection.records.length, 81);
  assertCompleteSource(projection, data);
  const before = JSON.stringify(projection);
  assert.doesNotThrow(() => assertMessageProcessingReadBudget(projection));
  assert.equal(JSON.stringify(projection), before);
  projection.records.push({ ...projection.records[0]!, messageId: "record-82" });
  const overBudget = JSON.stringify(projection);
  assert.throws(() => assertMessageProcessingReadBudget(projection), /transport budget/i);
  assert.equal(JSON.stringify(projection), overBudget);
});

test("whole UTF-8 projection including reviewed source and attachments accepts exactly 1 MiB, rejects +1 byte", t => {
  const data = fixture(t);
  const projection = readMessageProcessingProjection(data.input);
  assertCompleteSource(projection, data);
  assert.ok(projection.reviewedSource);
  const attachment = { ...data.formalRecord.attachments[0]!, transportPadding: "" };
  projection.reviewedSource.record.attachments = [attachment];
  const baseBytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
  assert.ok(baseBytes < BYTE_LIMIT);
  attachment.transportPadding = "x".repeat(BYTE_LIMIT - baseBytes);
  const exact = JSON.stringify(projection);
  assert.equal(Buffer.byteLength(exact, "utf8"), BYTE_LIMIT);
  assert.ok(exact.length < BYTE_LIMIT, "the fixture must distinguish UTF-8 bytes from JS string length");
  assert.doesNotThrow(() => assertMessageProcessingReadBudget(projection));
  assert.equal(JSON.stringify(projection), exact, "acceptance must not truncate source or attachments");
  fs.writeFileSync(data.groupFile, `${JSON.stringify(projection.reviewedSource.record)}\n`);
  assert.equal(JSON.stringify(readMessageProcessingProjection(data.input)), exact, "the actual reader must preserve the exact-limit payload");
  attachment.transportPadding += "x";
  const oversized = JSON.stringify(projection);
  assert.equal(Buffer.byteLength(oversized, "utf8"), BYTE_LIMIT + 1);
  assert.throws(() => assertMessageProcessingReadBudget(projection), /transport budget/i);
  assert.equal(JSON.stringify(projection), oversized, "rejection must not mutate the caller's evidence");
  const storedSource = `${JSON.stringify(projection.reviewedSource.record)}\n`;
  fs.writeFileSync(data.groupFile, storedSource);
  assert.throws(() => readMessageProcessingProjection(data.input), /transport budget/i);
  assert.equal(fs.readFileSync(data.groupFile, "utf8"), storedSource, "oversize source files must not be rewritten or truncated");
});

test("duplicate messageId fails closed even when the first record is a valid reviewed source", t => {
  const data = fixture(t);
  fs.appendFileSync(data.groupFile, `${JSON.stringify({ ...data.formalRecord, time: 2, rawMessage: "duplicate" })}\n`);
  assert.throws(() => readMessageProcessingProjection(data.input), /formal group history contains 2 matching records/i);
});

const inventoryMutations = [
  { name: "current", mutate: (data: ReturnType<typeof fixture>) => fs.appendFileSync(data.currentFile, "\n") },
  { name: "index", mutate: (data: ReturnType<typeof fixture>) => fs.appendFileSync(data.indexFile, " ") },
  { name: "existing archive", mutate: (data: ReturnType<typeof fixture>) => fs.appendFileSync(data.archiveFile, "\n") },
  { name: "new unindexed archive", mutate: (data: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(data.archiveDir, "2~2.jsonl"), "\n") },
  { name: "removed archive", mutate: (data: ReturnType<typeof fixture>) => fs.unlinkSync(data.archiveFile) },
  { name: "legacy", mutate: (data: ReturnType<typeof fixture>) => fs.appendFileSync(data.legacyFile, "\n") },
  { name: "group source", mutate: (data: ReturnType<typeof fixture>) => fs.appendFileSync(data.groupFile, "\n") }
];
for (const mutation of inventoryMutations) {
  test(`inventory rejects ${mutation.name} changing during the read`, t => {
    const data = fixture(t);
    const original = fs.readFileSync;
    let injected = false;
    t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (!injected && String(args[0]) === data.groupFile) {
        injected = true;
        mutation.mutate(data);
      }
      return result;
    }) as typeof fs.readFileSync);
    assert.throws(() => readMessageProcessingProjection(data.input), /files changed during the read/i);
    assert.equal(injected, true, "inject after the pre-read inventory, not before the projection starts");
  });
}

const clientSource = `
const { parentPort } = require('node:worker_threads');
const http = require('node:http');
let base;
function get(url) { return new Promise((resolve,reject) => {
  const request = http.get(url,response => { let body=''; response.setEncoding('utf8');
    response.on('data',part => body += part);
    response.on('end',() => { try { resolve({status:response.statusCode,body:JSON.parse(body)}); } catch(error) { reject(error); } });
  }); request.on('error',reject);
}); }
parentPort.on('message',async message => { try {
  if (message.type === 'start') { base=message.base; const result=await get(base+'/context'); parentPort.postMessage({type:'context',result}); }
  if (message.type === 'context-started') { const began=performance.now(); const result=await get(base+'/health'); parentPort.postMessage({type:'health',result,ms:performance.now()-began}); }
} catch(error) { parentPort.postMessage({type:'failure',error:String(error)}); } });
parentPort.postMessage({type:'ready'});
`;

test("real concurrency-one reader returns complete source while independent mini HTTP health stays responsive", { timeout: 15000 }, async t => {
  const data = fixture(t, 80);
  const filler = Array.from({ length: 1000 }, (_, index) => JSON.stringify({
    ...data.formalRecord, messageId: `unrelated-${index}`, rawMessage: "x".repeat(1100), attachments: []
  }));
  fs.writeFileSync(data.groupFile, `${filler.join("\n")}\n${JSON.stringify(data.formalRecord)}\n`);
  const inputBytes = fs.statSync(data.groupFile).size;
  assert.ok(inputBytes > 1_000_000 && inputBytes <= 2_000_000, `synthetic group input must be large but bounded: ${inputBytes}`);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 10000 });
  const client = new Worker(clientSource, { eval: true });
  const ready = new Promise<void>((resolve, reject) => { client.once("message", () => resolve()); client.once("error", reject); });
  const original = fs.readFileSync;
  let parentReads = 0;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).startsWith(data.input.roleDir + path.sep)) {
      parentReads++;
      throw new Error("source storage was read in the parent event loop");
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readFileSync);
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  let delegated = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { json(response, 200, { live: true }); return; }
    if (request.url !== "/context") { json(response, 404, {}); return; }
    delegated++;
    const pending = pool.run<MessageProcessingReadProjection>({ type: "message_processing_send_context", input: data.input });
    client.postMessage({ type: "context-started" });
    void pending.then(result => json(response, 200, result), error => json(response, 500, { error: String(error) }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    await ready;
    const address = server.address();
    assert.ok(address && typeof address === "object");
    type ClientMessage = { type: string; error?: string; result: { status: number; body: MessageProcessingReadProjection & { live?: boolean } }; ms?: number };
    const messages: ClientMessage[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      client.on("message", (message: ClientMessage) => {
        if (message.type === "failure") { reject(new Error(message.error)); return; }
        messages.push(message);
        if (messages.length === 2) resolve();
      });
      client.once("error", reject);
    });
    client.postMessage({ type: "start", base: `http://127.0.0.1:${address.port}` });
    await completed;
    const context = messages.find(item => item.type === "context")!;
    const health = messages.find(item => item.type === "health")!;
    assert.equal(context.result.status, 200, JSON.stringify(context.result.body));
    assert.equal(context.result.body.records.length, 81);
    assertCompleteSource(context.result.body, data);
    assert.equal(health.result.status, 200);
    assert.equal(health.result.body.live, true);
    assert.equal(messages[0]!.type, "health", "health must complete before the cold reader response");
    assert.equal(delegated, 1);
    assert.equal(parentReads, 0);
    assert.equal(pool.status().maxConcurrency, 1);
    assert.equal(pool.status().spawnedWorkers, 1);
    assert.ok(pool.status().workerPids.every(pid => pid !== process.pid));
    // Exercise the same worker failure path, not just the direct function's duplicate check.
    fs.appendFileSync(data.groupFile, `${JSON.stringify(data.formalRecord)}\n`);
    await assert.rejects(pool.run({ type: "message_processing_send_context", input: data.input }), /formal group history contains 2 matching records/i);
    assert.equal(parentReads, 0);
    console.log(JSON.stringify({ experiment: "message-processing-http-isolation", inputBytes, healthMs: health.ms,
      parentReads, returned: context.result.body.records.length, spawnedWorkers: pool.status().spawnedWorkers }));
  } finally {
    await client.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.stop();
  }
});

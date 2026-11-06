import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeliveryReplayLedgerIncompleteError, deliveryReplayLedgerPath, findDeliveryReplayAttempt,
  listDeliveryReplayAttemptSnapshot, listDeliveryReplayAttempts, readDeliveryReplayAttempts, readDeliveryReplayLedger } from "./deliveryReplayLedger.js";

const attempt = (attemptId: string, status = "failed") => ({ attemptId, time: 1, routeKind: "manual_trigger", messageId: `message-${attemptId}`,
  record: { messageId: `message-${attemptId}` }, extraValues: {}, packets: [],
  result: { status, matchedRuleCount: 0, sentPacketCount: 0, adapterOutcomes: [] } });

test("a damaged ledger row keeps healthy attempts available with line diagnostics and original IDs", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = deliveryReplayLedgerPath(root);
  const content = [JSON.stringify(attempt("first")), "{broken", JSON.stringify({ attemptId: "damaged", result: null }),
    JSON.stringify(attempt("last")), ""].join("\n");
  await fs.writeFile(file, content);
  const snapshot = listDeliveryReplayAttemptSnapshot(root, { limit: 1 });
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.attempts.map(row => row.attemptId), ["last"]);
  assert.deepEqual(snapshot.diagnostics.map(row => [row.lineNumber, row.code, row.attemptId]), [
    [2, "invalid_json", undefined], [3, "invalid_attempt", "damaged"]
  ]);
  assert.deepEqual(findDeliveryReplayAttempt(root, "first"), attempt("first"));
  assert.throws(() => findDeliveryReplayAttempt(root, "damaged"), DeliveryReplayLedgerIncompleteError);
  assert.throws(() => findDeliveryReplayAttempt(root, "unknown"), DeliveryReplayLedgerIncompleteError);
  assert.throws(() => listDeliveryReplayAttempts(root), DeliveryReplayLedgerIncompleteError);
  assert.throws(() => readDeliveryReplayAttempts(root), DeliveryReplayLedgerIncompleteError);
  assert.equal(await fs.readFile(file, "utf8"), content);
});

test("missing files, healthy empty ledgers and complete filtered lists keep their distinct results", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-ledger-complete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(readDeliveryReplayLedger(root), { attempts: [], diagnostics: [], partial: false });
  await fs.writeFile(deliveryReplayLedgerPath(root), "\n \n");
  assert.deepEqual(listDeliveryReplayAttempts(root), []);
  const rows = [attempt("old"), attempt("delivered", "delivered"), attempt("new")];
  await fs.writeFile(deliveryReplayLedgerPath(root), rows.map(row => JSON.stringify(row)).join("\r\n"));
  assert.deepEqual(listDeliveryReplayAttempts(root, { status: "failed", limit: 1 }).map(row => row.attemptId), ["new"]);
  assert.equal(findDeliveryReplayAttempt(root, "absent"), null);
  assert.deepEqual(readDeliveryReplayAttempts(root), rows);
  t.mock.method(fsSync, "readFileSync", () => { throw Object.assign(new Error("read denied"), { code: "EACCES" }); });
  assert.throws(() => readDeliveryReplayLedger(root), error => (error as NodeJS.ErrnoException).code === "EACCES");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { noteCodexDesktopLateStartForTest } from "../codexDesktopBridge.js";
import { assertEndpointOwnerDirectory, executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "./ownerExecution.js";
import type { PreparedEndpointDelivery } from "./endpointDelivery.js";
import { agentDeliveryPromptHash } from "./store.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";

test("owner directory checks existence rather than configured workspace membership", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-directory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertEndpointOwnerDirectory(directory));
  assert.throws(() => assertEndpointOwnerDirectory(undefined), /existing absolute/);
  assert.throws(() => assertEndpointOwnerDirectory("relative"), /existing absolute/);
  const file = path.join(directory, "file"); fs.writeFileSync(file, "fixture");
  assert.throws(() => assertEndpointOwnerDirectory(file), /existing absolute/);
  assert.throws(() => assertEndpointOwnerDirectory(path.join(directory, "missing")), /existing absolute/);
  const delivery = { target: { provider: "unimplemented" }, executionOptions: { cwd: directory } } as PreparedEndpointDelivery;
  let checks = 0;
  await assert.rejects(executeEndpointOnOwner(delivery, { allowedWorkspaces: [] }, () => { checks++; }), /no exact owner execution capability/);
  assert.equal(checks, 1);
  await assert.rejects(executeEndpointOnOwner(delivery, { allowedWorkspaces: [path.join(directory, "different")] }, () => {}), /no exact owner execution capability/);
});

test("exact owner recovery accepts a historical suffix only with the original scoped ID and reserved prompt hash", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-receipt-"));
  const originalHome = process.env.CODEX_HOME;
  const originalSqliteHome = process.env.CODEX_SQLITE_HOME;
  process.env.CODEX_HOME = directory;
  process.env.CODEX_SQLITE_HOME = directory;
  t.after(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    if (originalSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = originalSqliteHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const rolloutPath = path.join(directory, "owner.jsonl");
  const db = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT)`);
  db.prepare("INSERT INTO threads VALUES (?, '', ?, ?, 1, 1000, 1, 1000, 0, '')")
    .run("exact-owner", directory, rolloutPath);
  db.close();
  const deliveryId = `agent-${"a".repeat(64)}`;
  const prompt = renderRabiDelivery({
    messageSource: { type: "agent", agentAdapter: "grokBot", sessionId: "external-owner", sessionName: "External owner" },
    messageContent: "Exact original reply",
    controlBlocks: ["[回传参数]\n" + JSON.stringify({ deliveryId, responsePolicy: "none" })]
  });
  const source = { kind: "service", managerInstanceId: "stable-manager", agentId: "external-agent", provider: "grokBot",
    sessionId: "external-owner", authorizationIncarnation: "account-epoch" } as const;
  const target = { kind: "local", managerInstanceId: "stable-manager", agentId: "receiver-agent", provider: "codex",
    sessionId: "exact-owner", authorizationIncarnation: "receiver-epoch" } as const;
  const delivery: PreparedEndpointDelivery = { deliveryId, generation: "original-preparation", source, target,
    prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions: { cwd: directory },
    executionOptionsHash: "original-options-hash", state: "dispatching", preparation: { deliveryId, responsePolicy: "none",
      source: { threadId: source.sessionId, agentType: "agent", agentAdapter: "grokBot", endpoint: source },
      target: { threadId: target.sessionId, agentType: "agent", agentAdapter: "codex", endpoint: target } } };
  const suffix = "\n\n[投递编号]\ndeliveryId: 12345678-1234-4567-8123-123456789abc";
  const writeMessage = (text: string, role = "user") => fs.writeFileSync(rolloutPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } }) + "\n");
  for (const altered of ["quoted\n" + prompt + suffix, prompt.replace("Exact", "Altered") + suffix,
    prompt + suffix + suffix, prompt + suffix + "\nextra", prompt.replace(deliveryId, `agent-${"b".repeat(64)}`) + suffix]) {
    writeMessage(altered);
    assert.equal(await recoverEndpointOwnerReceipt(delivery, () => {}), undefined);
  }
  for (const role of ["assistant", "tool"]) {
    writeMessage(prompt + suffix, role);
    assert.equal(await recoverEndpointOwnerReceipt(delivery, () => {}), undefined);
  }
  const releaseLate = noteCodexDesktopLateStartForTest("exact-owner", deliveryId);
  fs.writeFileSync(rolloutPath, "");
  assert.equal((await recoverEndpointOwnerReceipt(delivery, () => {}))?.action, "receipt_recovered");
  assert.equal(await recoverEndpointOwnerReceipt({ ...delivery, deliveryId: `agent-${"c".repeat(64)}` }, () => {}), undefined);
  releaseLate();
  assert.equal(await recoverEndpointOwnerReceipt(delivery, () => {}), undefined);
  for (const text of [prompt, prompt + suffix, (prompt + suffix).replace(/\n/g, "\r\n")]) {
    writeMessage(text);
    let checks = 0;
    const receipt = await recoverEndpointOwnerReceipt(delivery, () => { checks++; });
    assert.deepEqual(receipt, { deliveryId, generation: delivery.generation, endpoint: target,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      accepted: true, action: "receipt_recovered", transport: "desktop-ipc" });
    assert.ok(checks >= 3);
  }
  writeMessage(prompt + suffix);
  await assert.rejects(recoverEndpointOwnerReceipt(delivery, () => { throw new Error("owner revoked"); }), /owner revoked/);
  const archivedDb = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  archivedDb.exec("UPDATE threads SET archived = 1");
  archivedDb.close();
  assert.equal(await recoverEndpointOwnerReceipt(delivery, () => {}), undefined);
});

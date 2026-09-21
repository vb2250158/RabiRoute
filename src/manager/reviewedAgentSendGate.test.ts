import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentSendRequest, AgentSendResult } from "../agentSend.js";
import type { ValidatedMessageProcessingSendContext } from "../messageProcessing/sendContextReview.js";
import {
  agentSendReceiptPath,
  executeIdempotentAgentSend,
  readAgentSendReceipt,
  type AgentSendReceipt
} from "./agentSendIdempotency.js";
import {
  assertReviewedAgentSendMayDeliver,
  resolveReviewedAgentSendGate,
  type ReviewedAgentSendGate
} from "./reviewedAgentSendGate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-reviewed-send-gate-"));
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(rootDir), false);
  });
  const request = {
    deliveryId: "reviewed-delivery-1",
    sender: { agentType: "codex", sessionId: "reviewed-session-1" },
    routeId: "reviewed-route",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "reviewed payload" }
  } satisfies AgentSendRequest;
  let deliveries = 0;
  const deliver = async (): Promise<AgentSendResult> => {
    deliveries += 1;
    return { ok: true, status: "sent", sentMessageId: "mock-message-1" };
  };
  const readReceipt = (deliveryId: string) => readAgentSendReceipt(rootDir, deliveryId);
  const execute = (sendRequest: AgentSendRequest = request) => executeIdempotentAgentSend(sendRequest, { rootDir, deliver });
  const executeGate = (gate: ReviewedAgentSendGate) => executeIdempotentAgentSend(gate.request, {
    rootDir,
    deliver: async () => {
      assertReviewedAgentSendMayDeliver(gate);
      return deliver();
    }
  });
  return { rootDir, request, readReceipt, execute, executeGate, deliveries: () => deliveries };
}

test("validated context passes through only after missing receipt reread and reauthorization", async (t) => {
  const f = fixture(t);
  const context: ValidatedMessageProcessingSendContext = {
    sourceMessageId: "source-message-1",
    requirement: {
      id: "requirement-1",
      dedupeKey: "requirement-dedupe-1",
      kind: "message_reply",
      replyPolicy: "required",
      status: "awaiting_send",
      source: {
        routeId: f.request.routeId,
        endpoint: "napcat",
        conversationKey: "fixture-conversation",
        sender: "fixture-sender",
        routeKinds: [],
        messageIds: ["source-message-1"]
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-01-01T01:00:00.000Z"
    }
  };
  const events: string[] = [];
  const gate = await resolveReviewedAgentSendGate(f.request, {
    readReceipt: (id) => { events.push("read"); return f.readReceipt(id); },
    authorize: () => { events.push("authorize"); },
    validate: async () => {
      events.push("validate");
      await Promise.resolve();
      return context;
    }
  });
  assert.deepEqual(events, ["read", "authorize", "validate", "read", "authorize"]);
  assert.equal(gate.context, context);
  assert.equal(gate.context.sourceMessageId, "source-message-1");
  assert.equal(gate.receipt, null);
  assert.equal(gate.replayOnly, false);
  assert.equal(f.deliveries(), 0);
});

for (const validationFails of [false, true]) {
  test(`terminal receipt created by original owner during validation is replayed (validationFails=${validationFails})`, async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    const validationError = new Error("review expired during await");
    const events: string[] = [];
    const resolving = resolveReviewedAgentSendGate(f.request, {
      readReceipt: (id) => { events.push("read"); return f.readReceipt(id); },
      authorize: () => { events.push("authorize"); },
      validate: async () => {
        events.push("validate");
        entered.resolve();
        await release.promise;
        if (validationFails) throw validationError;
        return undefined;
      }
    });
    await entered.promise;
    try {
      assert.equal(f.readReceipt(f.request.deliveryId), null);
      const original = await f.execute();
      assert.equal(original.statusCode, 202);
      assert.equal(original.body.idempotency.duplicate, false);
      assert.equal(f.readReceipt(f.request.deliveryId)?.state, "completed");
    } finally {
      release.resolve();
    }
    const gate = await resolving;
    assert.deepEqual(events, ["read", "authorize", "validate", "read"]);
    assert.equal(gate.replayOnly, true);
    assert.equal(gate.context, undefined);
    assert.deepEqual(gate.receipt, f.readReceipt(f.request.deliveryId));
    const replay = await f.executeGate(gate);
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.body.idempotency.duplicate, true);
    assert.equal(replay.body.sentMessageId, "mock-message-1");
    assert.equal(f.deliveries(), 1);
  });
}

for (const changedField of ["payload", "sender", "params"] as const) {
  test(`original owner rejects same deliveryId with changed ${changedField} after validation race`, async (t) => {
    const f = fixture(t);
    const changed = structuredClone(f.request);
    if (changedField === "payload") changed.payload.text = "different payload";
    if (changedField === "sender") changed.sender.sessionId = "different-session";
    if (changedField === "params") changed.params.groupId = "789";
    const gate = await resolveReviewedAgentSendGate(changed, {
      readReceipt: f.readReceipt,
      authorize: () => undefined,
      validate: async () => {
        await f.execute();
        throw new Error("review rejected");
      }
    });
    assert.equal(gate.replayOnly, true);
    const conflict = await f.executeGate(gate);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.idempotency.state, "conflict");
    assert.equal(f.deliveries(), 1);
  });
}

test("existing terminal receipt is authorized but skips validation and only replays", async (t) => {
  const f = fixture(t);
  await f.execute();
  let authorizations = 0;
  const gate = await resolveReviewedAgentSendGate(f.request, {
    readReceipt: f.readReceipt,
    authorize: (request, receipt) => {
      authorizations += 1;
      assert.deepEqual(request, f.request);
      assert.equal(receipt?.state, "completed");
    },
    validate: async () => { assert.fail("terminal replay must not require a new review"); }
  });
  assert.equal(authorizations, 1);
  assert.equal(gate.replayOnly, true);
  assert.equal((await f.executeGate(gate)).body.idempotency.duplicate, true);
  assert.equal(f.deliveries(), 1);
});

// Nonterminal/malformed receipts are dependency fixtures, never writes to live storage.
const blockedReceipts: Array<{ label: string; state: AgentSendReceipt["state"]; result?: AgentSendResult }> = [
  { label: "reserved", state: "reserved" },
  { label: "sending", state: "sending" },
  { label: "uncertain", state: "uncertain" },
  { label: "completed without result", state: "completed" }
];
for (const blocked of blockedReceipts) {
  for (const timing of ["initial", "after validation success", "after validation failure"] as const) {
    test(`${blocked.label} cannot bypass gate (${timing})`, async (t) => {
      const f = fixture(t);
      const receipt: AgentSendReceipt = {
        version: 1,
        deliveryId: f.request.deliveryId,
        requestDigest: "fixture-digest",
        state: blocked.state,
        result: blocked.result,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      let reads = 0;
      let validations = 0;
      const reviewError = new Error("review denied");
      const resolving = resolveReviewedAgentSendGate(f.request, {
        readReceipt: () => {
          reads += 1;
          return timing === "initial" || reads > 1 ? receipt : null;
        },
        authorize: () => undefined,
        validate: async () => {
          validations += 1;
          await Promise.resolve();
          if (timing === "after validation failure") throw reviewError;
          return undefined;
        }
      }).then(f.executeGate);
      await assert.rejects(resolving, timing === "after validation failure"
        ? (error: unknown) => error === reviewError
        : /context validation cannot authorize a retry/);
      assert.equal(reads, timing === "initial" ? 1 : 2);
      assert.equal(validations, timing === "initial" ? 0 : 1);
      assert.equal(f.deliveries(), 0);
    });
  }
}

for (const validationFails of [false, true]) {
  test(`receipt reread failure prevents delivery (validationFails=${validationFails})`, async (t) => {
    const f = fixture(t);
    const readError = new Error("authoritative receipt read failed");
    const reviewError = new Error("review denied");
    let reads = 0;
    const resolving = resolveReviewedAgentSendGate(f.request, {
      readReceipt: () => {
        reads += 1;
        if (reads === 2) throw readError;
        return null;
      },
      authorize: () => undefined,
      validate: async () => {
        await Promise.resolve();
        if (validationFails) throw reviewError;
        return undefined;
      }
    }).then(f.executeGate);
    await assert.rejects(resolving, (error: unknown) => {
      if (!validationFails) return error === readError;
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [reviewError, readError]);
      assert.equal(error.cause, reviewError);
      return true;
    });
    assert.equal(reads, 2);
    assert.equal(f.deliveries(), 0);
    assert.equal(f.readReceipt(f.request.deliveryId), null);
  });
}

test("initial receipt read failure prevents authorization, validation and delivery", async (t) => {
  const f = fixture(t);
  const readError = new Error("initial receipt read failed");
  await assert.rejects(resolveReviewedAgentSendGate(f.request, {
    readReceipt: () => { throw readError; },
    authorize: () => assert.fail("must not authorize after read failure"),
    validate: async () => { assert.fail("must not validate after read failure"); }
  }).then(f.executeGate), (error: unknown) => error === readError);
  assert.equal(f.deliveries(), 0);
});

test("validation failure without terminal receipt is preserved after authoritative reread", async (t) => {
  const f = fixture(t);
  const reviewError = new Error("review denied");
  let reads = 0;
  let authorizations = 0;
  await assert.rejects(resolveReviewedAgentSendGate(f.request, {
    readReceipt: (id) => { reads += 1; return f.readReceipt(id); },
    authorize: () => { authorizations += 1; },
    validate: async () => { throw reviewError; }
  }).then(f.executeGate), (error: unknown) => error === reviewError);
  assert.equal(reads, 2);
  assert.equal(authorizations, 1);
  assert.equal(f.deliveries(), 0);
});

test("await-time input mutations cannot change the deeply frozen authorized snapshot", async (t) => {
  const f = fixture(t);
  const original = structuredClone(f.request);
  const entered = deferred();
  const release = deferred();
  const authorized: AgentSendRequest[] = [];
  const readIds: string[] = [];
  let validated: AgentSendRequest | undefined;
  const resolving = resolveReviewedAgentSendGate(f.request, {
    readReceipt: (id) => { readIds.push(id); return f.readReceipt(id); },
    authorize: (request) => { authorized.push(request); },
    validate: async (request) => {
      validated = request;
      entered.resolve();
      await release.promise;
      return undefined;
    }
  });
  await entered.promise;
  f.request.deliveryId = "mutated-delivery";
  f.request.sender.sessionId = "mutated-session";
  f.request.payload.text = "mutated payload";
  f.request.params.groupId = "789";
  release.resolve();
  const gate = await resolving;
  assert.deepEqual(gate.request, original);
  assert.notEqual(gate.request, f.request);
  assert.equal(validated, gate.request);
  assert.deepEqual(authorized, [gate.request, gate.request]);
  assert.equal(authorized[0], authorized[1]);
  assert.deepEqual(readIds, [original.deliveryId, original.deliveryId]);
  for (const value of [gate.request, gate.request.sender, gate.request.payload, gate.request.params]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { gate.request.deliveryId = "forbidden mutation"; }, TypeError);
  assert.equal(gate.replayOnly, false);
  assert.equal(gate.receipt, null);
  assert.doesNotThrow(() => assertReviewedAgentSendMayDeliver(gate));
  const delivered = await f.executeGate(gate);
  assert.equal(delivered.statusCode, 202);
  assert.equal(delivered.body.deliveryId, original.deliveryId);
  assert.deepEqual(delivered.body.sender, original.sender);
  assert.equal(f.deliveries(), 1);
});

for (const failAt of [1, 2]) {
  test(`authorization failure at check ${failAt} prevents new delivery`, async (t) => {
    const f = fixture(t);
    let authorizations = 0;
    let validations = 0;
    const denied = new Error("policy no longer permits sending");
    await assert.rejects(resolveReviewedAgentSendGate(f.request, {
      readReceipt: f.readReceipt,
      authorize: () => {
        authorizations += 1;
        if (authorizations === failAt) throw denied;
      },
      validate: async () => { validations += 1; return undefined; }
    }).then(f.executeGate), (error: unknown) => error === denied);
    assert.equal(authorizations, failAt);
    assert.equal(validations, failAt - 1);
    assert.equal(f.deliveries(), 0);
  });
}

test("replayOnly guard prevents new mock delivery when completed receipt disappears", async (t) => {
  const f = fixture(t);
  await f.execute();
  const gate = await resolveReviewedAgentSendGate(f.request, {
    readReceipt: f.readReceipt,
    authorize: () => undefined,
    validate: async () => { assert.fail("terminal receipt must skip review"); }
  });
  assert.equal(gate.replayOnly, true);
  assert.throws(() => assertReviewedAgentSendMayDeliver(gate), /refusing a new delivery/);
  fs.unlinkSync(agentSendReceiptPath(f.rootDir, f.request.deliveryId));
  assert.equal(f.readReceipt(f.request.deliveryId), null);
  // The real owner catches the guard exception and records uncertainty; it must not send.
  const response = await f.executeGate(gate);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.idempotency.state, "uncertain");
  assert.match(response.body.reason || "", /refusing a new delivery/);
  assert.equal(f.deliveries(), 1);
});

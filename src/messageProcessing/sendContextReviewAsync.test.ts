import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSendRequest } from "../agentSend.js";
import type { MessageContextRecord } from "../messageContextStore.js";
import type { MessageProcessingRequirement } from "./board.js";
import type { RecoverMessageProcessingSourceRecordOptions, ReviewedMessageProcessingSourceRecordEvidence } from "./sourceContextRecovery.js";
import {
  MessageProcessingSendContextReview,
  type MessageProcessingSendContextApprovalInput
} from "./sendContextReview.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requirement(): MessageProcessingRequirement {
  return {
    id: "requirement-1",
    dedupeKey: "message-group:requirement-1",
    kind: "message_reply",
    replyPolicy: "required",
    status: "awaiting_send",
    source: {
      routeId: "route-main",
      routeProfileId: "route-main",
      roleId: "test-persona",
      endpoint: "napcat",
      conversationKey: "napcat:group:456",
      sender: "user-1",
      routeKinds: ["direct_reply"],
      messageIds: ["source-1"],
      summary: "原始问题",
      replyContext: { groupId: "456", messageId: "source-1" }
    },
    createdAt: "2026-08-11T09:40:00.000Z",
    updatedAt: "2026-08-11T09:41:00.000Z",
    dueAt: "2026-08-11T09:50:00.000Z"
  };
}

function sendRequest(): AgentSendRequest {
  return {
    deliveryId: "delivery-1",
    sender: { agentType: "message_processing", sessionId: "message-agent-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-1" },
    payload: { type: "text", text: "对原始问题的回复。" },
    tracking: { requirementId: "requirement-1" }
  };
}

function contextRecord(messageId = "source-1", time = 1): MessageContextRecord {
  return {
    id: `context-${messageId}`,
    time,
    direction: "inbound",
    adapter: "napcat",
    channel: "napcat",
    conversationKey: "napcat:group:456",
    sender: "user-1",
    text: "原始问题",
    messageId
  };
}

function fixture(sharedRequirementReference = false) {
  const state = {
    requirement: requirement() as MessageProcessingRequirement | undefined,
    records: [contextRecord()],
    now: Date.parse("2026-08-11T09:42:00.000Z"),
    loadCalls: 0,
    sourceOptions: [] as Array<RecoverMessageProcessingSourceRecordOptions | undefined>,
    sourceProof: undefined as ReviewedMessageProcessingSourceRecordEvidence | undefined,
    additionalOwners: [] as MessageProcessingRequirement[]
  };
  const pendingLoads: ReturnType<typeof deferred<MessageContextRecord[]>>[] = [];
  const review = new MessageProcessingSendContextReview({
    // 生产 store 返回副本；共享引用模式专门检测 await 前是否真的捕获快照。
    getRequirement: (id) => state.requirement?.id === id
      ? (sharedRequirementReference ? state.requirement : structuredClone(state.requirement))
      : undefined,
    findRequirementBySourceMessage: (_routeId, messageId) => state.requirement?.source.messageIds.includes(messageId)
      ? structuredClone(state.requirement)
      : undefined,
    findRequirementsBySourceMessage: (_routeId, messageId) => [
      ...(state.requirement ? [state.requirement] : []),
      ...state.additionalOwners
    ].filter((owner) => owner.source.messageIds.includes(messageId)).map((owner) => structuredClone(owner)),
    loadContext: async (_requirement, _sourceMessageId, options) => {
      state.loadCalls += 1;
      state.sourceOptions.push(options);
      const pending = pendingLoads.shift();
      const records = pending ? await pending.promise : structuredClone(state.records);
      return options && state.sourceProof ? { records, reviewedSource: structuredClone(state.sourceProof) } : records;
    },
    now: () => new Date(state.now)
  });
  return {
    state,
    review,
    pauseNextLoad() {
      const pending = deferred<MessageContextRecord[]>();
      pendingLoads.push(pending);
      return pending;
    },
    async approvalInput(): Promise<MessageProcessingSendContextApprovalInput> {
      const snapshot = await review.snapshot("requirement-1", "source-1");
      return {
        contextVersion: snapshot.contextVersion,
        reviewedContextIds: snapshot.requiredReviewIds,
        reviewedByThreadId: "message-agent-1",
        proposedSend: sendRequest(),
        reason: "已核对精确来源与正文。"
      };
    },
    async approvedRequest() {
      const input = await this.approvalInput();
      const approval = await review.approve("requirement-1", input);
      input.proposedSend.tracking = {
        requirementId: "requirement-1",
        sendContextReviewToken: approval.sendContextReviewToken
      };
      return { request: input.proposedSend, approval };
    }
  };
}

const requirementChanged = /requirement.*(?:changed|not found|awaiting_send)|(?:changed|not found).*requirement/i;
const contextChanged = /context changed.*review again/i;
const requestChanged = /(?:request|payload|input|proposed send|approval).*changed|changed.*(?:request|payload|input)/i;

test("async context loading supports the public snapshot, approval and validation flow", async () => {
  const f = fixture();
  const { request } = await f.approvedRequest();
  const validated = await f.review.validateSend(request);
  assert.equal(validated?.requirement.id, "requirement-1");
  assert.equal(validated?.sourceMessageId, "source-1");
  assert.equal(request.deliveryId, "delivery-1");
  assert.equal(f.state.loadCalls, 3);
});

const mutations: { name: string; shared?: boolean; apply: (state: ReturnType<typeof fixture>["state"]) => void }[] = [
  { name: "requirement removed", apply: (state) => { state.requirement = undefined; } },
  { name: "requirement replaced", apply: (state) => {
    state.requirement = { ...state.requirement!, updatedAt: "2026-08-11T09:43:00.000Z" };
  } },
  { name: "same object status revoked", shared: true, apply: (state) => {
    state.requirement!.status = "not_required";
  } },
  { name: "same updatedAt with replaced source", apply: (state) => {
    state.requirement = {
      ...state.requirement!,
      source: { ...state.requirement!.source, summary: "替换后的来源事实" }
    };
  } },
  { name: "same object and updatedAt with source mutated in place", shared: true, apply: (state) => {
    state.requirement!.source.summary = "原地修改的来源事实";
  } }
];

for (const operation of ["snapshot", "approve", "validateSend"] as const) {
  for (const mutation of mutations) {
    test(`${operation} fails closed when ${mutation.name} during deferred context loading`, async () => {
      const f = fixture(mutation.shared);
      const input = operation === "approve" ? await f.approvalInput() : undefined;
      const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
      const gate = f.pauseNextLoad();
      const beforeCalls = f.state.loadCalls;
      const pending = operation === "snapshot"
        ? f.review.snapshot("requirement-1", "source-1")
        : operation === "approve"
          ? f.review.approve("requirement-1", input!)
          : f.review.validateSend(approved!.request);
      const rejected = assert.rejects(pending, requirementChanged);
      assert.equal(f.state.loadCalls, beforeCalls + 1, "mutation must occur after loadContext starts");
      mutation.apply(f.state);
      gate.resolve(structuredClone(f.state.records));
      await rejected;
    });
  }
}

for (const operation of ["approve", "validateSend"] as const) {
  test(`${operation} rejects a contextVersion changed during deferred loading`, async () => {
    const f = fixture();
    const input = await f.approvalInput();
    const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
    const gate = f.pauseNextLoad();
    const pending = operation === "approve"
      ? f.review.approve("requirement-1", input)
      : f.review.validateSend(approved!.request);
    const rejected = assert.rejects(pending, contextChanged);
    gate.resolve([...f.state.records, contextRecord("new-message", 2)]);
    await rejected;
  });

  test(`${operation} rejects an ownership conflict appearing during deferred loading`, async () => {
    const f = fixture();
    const input = await f.approvalInput();
    const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
    const gate = f.pauseNextLoad();
    const pending = operation === "approve"
      ? f.review.approve("requirement-1", input)
      : f.review.validateSend(approved!.request);
    const rejected = assert.rejects(pending, /conflicting message-processing requirements/i);
    f.state.additionalOwners.push({ ...requirement(), id: "requirement-conflict" });
    gate.resolve(structuredClone(f.state.records));
    await rejected;
  });

  test(`${operation} rejects payload mutation while context loading is pending`, async () => {
    const f = fixture();
    const input = await f.approvalInput();
    const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
    const request = approved?.request ?? input.proposedSend;
    const gate = f.pauseNextLoad();
    const pending = operation === "approve"
      ? f.review.approve("requirement-1", input)
      : f.review.validateSend(request);
    const rejected = assert.rejects(pending, requestChanged);
    Object.assign(request.payload!, { text: "等待期间被替换的正文。" });
    gate.resolve(structuredClone(f.state.records));
    await rejected;
  });
}

test("validation rechecks token expiry after deferred context loading", async () => {
  const f = fixture();
  const { request, approval } = await f.approvedRequest();
  const gate = f.pauseNextLoad();
  const pending = f.review.validateSend(request);
  const rejected = assert.rejects(pending, /review.*expired/i);
  f.state.now = Date.parse(approval.expiresAt);
  gate.resolve(structuredClone(f.state.records));
  await rejected;
  await assert.rejects(f.review.validateSend(request), /token.*(?:missing|expired)|review.*expired/i);
});

for (const operation of ["snapshot", "approve", "validateSend"] as const) {
  test(`${operation} propagates deferred context read failures without fallback`, async () => {
    const f = fixture();
    const input = operation === "approve" ? await f.approvalInput() : undefined;
    const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
    const gate = f.pauseNextLoad();
    const pending = operation === "snapshot"
      ? f.review.snapshot("requirement-1", "source-1")
      : operation === "approve"
        ? f.review.approve("requirement-1", input!)
        : f.review.validateSend(approved!.request);
    const error = new Error("isolated context read failed");
    const rejected = assert.rejects(pending, (actual) => actual === error);
    gate.reject(error);
    await rejected;
  });
}

test("concurrent approvals and validations preserve the same deliveryId without adding send idempotency", async () => {
  const f = fixture();
  const firstInput = await f.approvalInput();
  const secondInput = structuredClone(firstInput);
  const firstGate = f.pauseNextLoad();
  const secondGate = f.pauseNextLoad();
  const firstPending = f.review.approve("requirement-1", firstInput);
  const secondPending = f.review.approve("requirement-1", secondInput);
  secondGate.resolve(structuredClone(f.state.records));
  const secondApproval = await secondPending;
  firstGate.resolve(structuredClone(f.state.records));
  const firstApproval = await firstPending;
  assert.notEqual(firstApproval.sendContextReviewToken, secondApproval.sendContextReviewToken);
  const requests = [firstInput.proposedSend, secondInput.proposedSend];
  [firstApproval, secondApproval].forEach((approval, index) => {
    requests[index]!.tracking = {
      requirementId: "requirement-1",
      sendContextReviewToken: approval.sendContextReviewToken
    };
  });
  const validationGates = [f.pauseNextLoad(), f.pauseNextLoad()];
  const validations = requests.map((request) => f.review.validateSend(request));
  validationGates[1]!.resolve(structuredClone(f.state.records));
  validationGates[0]!.resolve(structuredClone(f.state.records));
  const results = await Promise.all(validations);
  assert.deepEqual(results.map((result) => result?.requirement.id), ["requirement-1", "requirement-1"]);
  assert.deepEqual(requests.map((request) => request.deliveryId), ["delivery-1", "delivery-1"]);
  for (const request of requests) {
    await assert.rejects(f.review.validateSend({ ...request, deliveryId: "delivery-other" }), /request changed/i);
  }
});

for (const operation of ["approve", "validateSend"] as const) {
  test(`concurrent ${operation} calls each recheck the store after their own context wait`, async () => {
    const f = fixture(true);
    const input = await f.approvalInput();
    const approved = operation === "validateSend" ? await f.approvedRequest() : undefined;
    const firstGate = f.pauseNextLoad();
    const secondGate = f.pauseNextLoad();
    const start = () => operation === "approve"
      ? f.review.approve("requirement-1", structuredClone(input))
      : f.review.validateSend(structuredClone(approved!.request));
    const first = start();
    const second = start();
    const secondRejected = assert.rejects(second, requirementChanged);
    firstGate.resolve(structuredClone(f.state.records));
    assert.ok(await first);
    // 模拟唯一 store 接收到已有发送结果，不执行真实发送或另一套 reservation。
    f.state.requirement!.status = "sent";
    secondGate.resolve(structuredClone(f.state.records));
    await secondRejected;
    assert.equal((approved?.request ?? input.proposedSend).deliveryId, "delivery-1");
  });
}

test("only validation requests exact source proof and uses the same deferred context read", async () => {
  const f = fixture();
  const approved = await f.approvedRequest();
  assert.ok(f.state.sourceOptions.every(options => options === undefined));
  f.state.sourceProof = { roleDir: "synthetic-role", routeId: "route-main", groupId: "456", sourceMessageId: "source-1",
    record: { messageId: "source-1" }, contextRecord: contextRecord(), reviewedAttachmentIds: [] };
  const before = f.state.loadCalls;
  const pending = f.pauseNextLoad();
  const validation = f.review.validateSend(approved.request);
  pending.resolve(structuredClone(f.state.records));
  const result = await validation;
  assert.equal(f.state.loadCalls, before + 1);
  assert.deepEqual(f.state.sourceOptions.at(-1), { expectedGroupId: "456", expectedInstanceId: "" });
  assert.deepEqual(result?.reviewedSource, f.state.sourceProof);
  assert.notEqual(result?.reviewedSource, f.state.sourceProof);
});

for (const failure of ["revoked", "timeout", "aborted"] as const) {
  test(`combined source validation fails closed when ${failure} before its single read completes`, async () => {
    const f = fixture(true); const approved = await f.approvedRequest();
    const pending = f.pauseNextLoad(); const validation = f.review.validateSend(approved.request);
    const rejected = assert.rejects(validation);
    if (failure === "revoked") { f.state.requirement!.status = "sent"; pending.resolve(f.state.records); }
    else pending.reject(new Error(failure));
    await rejected;
  });
}

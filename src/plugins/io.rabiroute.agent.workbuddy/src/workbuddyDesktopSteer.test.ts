import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { requestWorkbuddyDesktopMessage, requestWorkbuddyDesktopSteer, serveWorkbuddyDesktopRelay } from "./workbuddyDesktopRelay.js";
import { dispatchWorkbuddyDesktopMessage, workbuddyDesktopContinuationReadinessExpression, workbuddyDesktopMessageExpression } from "./workbuddyDesktopSteer.js";
import { workbuddyRecordConfirmsDelivery } from "./workbuddyHistory.js";
import { RABI_MESSAGE_CONTENT_HEADER, RABI_MESSAGE_SOURCE_HEADER } from "@rabiroute/host-api/shared/rabiMessage";

const input = { threadId: "task-1", workspace: "C:/Projects/One", text: 'Keep working\n"guidance"', deliveryId: "delivery-1" };

test("native steering requests immediate delivery in the active local conversation at dispatch", async () => {
  const sends: unknown[][] = [];
  const thread = {
    info: { id: input.threadId, transport: "local", state: "working", space: { cwd: "c:\\projects\\one\\" } },
    sendPrompt: async (...args: unknown[]) => {
      sends.push(args);
      return { disposition: "queued", item: { id: "native-item" } };
    }
  };
  const window = { wb: { conversations: { get: async (id: string) => {
    assert.equal(id, input.threadId);
    return thread;
  } } } };
  const evaluate = async () => JSON.parse(JSON.stringify(await runInNewContext(workbuddyDesktopMessageExpression(input), { window })));
  assert.deepEqual(await evaluate(), { state: "accepted", threadId: input.threadId, deliveryId: input.deliveryId });
  assert.equal(sends.length, 1);
  const [blocks, options] = JSON.parse(JSON.stringify(sends[0]));
  assert.deepEqual(blocks, [{ type: "text", text: input.text }]);
  assert.equal(options.queueDelivery, "steer");
  assert.equal(options.clientRequestId, input.deliveryId);
  thread.info.state = "idle";
  assert.equal((await evaluate()).state, "inactive");
  thread.info.state = "working";
  thread.info.space.cwd = "C:/Another/One";
  assert.equal((await evaluate()).state, "unavailable");
  assert.equal(sends.length, 1);
});

test("a missing or mismatched native acknowledgement remains unknown after WorkBuddy's send boundary", async () => {
  for (const result of [undefined, null, { disposition: "queued", item: { id: "" } },
    { disposition: "queued", item: { id: "a", clientRequestId: "other" } }]) {
    let submitted = 0;
    const thread = {
      info: { id: input.threadId, transport: "local", state: "working", space: { cwd: input.workspace } },
      sendPrompt: async () => {
        submitted++;
        // The original active state can end while the native owner admits the request.
        thread.info.state = "idle";
        return result;
      }
    };
    const window = { wb: { conversations: { get: async () => thread } } };
    const receipt = await runInNewContext(workbuddyDesktopMessageExpression(input), { window });
    assert.equal(receipt.state, "unknown");
    assert.equal(submitted, 1);
  }
});

test("ordinary continuation reuses the exact idle desktop chat and keeps the native default queue policy", async () => {
  const calls: Array<{ text: string; options: Record<string, unknown> }> = [];
  const info = { id: input.threadId, transport: "local", state: "idle", space: { cwd: input.workspace } };
  const window = { wb: { conversations: { get: async (threadId: string) => {
    assert.equal(threadId, input.threadId);
    return { info, sendPrompt: async (blocks: Array<{ text: string }>, options: Record<string, unknown>) => {
      calls.push({ text: blocks[0]!.text, options });
      return undefined;
    } };
  } } } };
  const evaluate = () => runInNewContext(workbuddyDesktopMessageExpression(input, "continue"), { window });
  assert.equal((await evaluate()).state, "unknown");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.text, input.text);
  assert.equal(calls[0]!.options.clientRequestId, input.deliveryId);
  assert.equal(calls[0]!.options.queueDelivery, undefined);
  info.id = "another";
  assert.equal((await evaluate()).state, "unavailable");
  assert.equal(calls.length, 1);
});

test("only the original native injected user record can recover a steer receipt", () => {
  const record = { type: "message", role: "user", sessionId: input.threadId,
    content: `${RABI_MESSAGE_SOURCE_HEADER}\n- 投递 ID：${input.deliveryId}\n${RABI_MESSAGE_CONTENT_HEADER}\n${input.text}`,
    providerData: { startsNewUserRequest: false, rootRequestId: "turn-A", conversationRequestId: "turn-A" } };
  const confirms = (candidate: typeof record) => workbuddyRecordConfirmsDelivery(candidate, input.threadId, input.deliveryId, true);
  assert.equal(confirms(record), true);
  assert.equal(confirms({ ...record, sessionId: "another" }), false);
  assert.equal(confirms({ ...record, providerData: { ...record.providerData, startsNewUserRequest: true } }), false);
  assert.equal(confirms({ ...record, providerData: { ...record.providerData, conversationRequestId: "turn-B" } }), false);
  assert.equal(confirms({ ...record, content: record.content.replace(input.deliveryId, "other") }), false);
});

test("cold continuation waits for the desktop lookup and original workspace without exposing or sending the prompt", async () => {
  const window: { wb?: unknown } = {};
  const readiness = workbuddyDesktopContinuationReadinessExpression(input);
  assert.ok(!readiness.includes("Keep working"));
  assert.ok(!readiness.includes(input.deliveryId));
  const lookup = () => runInNewContext(readiness, { window });
  assert.equal(await lookup(), "loading");

  let sends = 0;
  let visible = false;
  const info = { id: input.threadId, transport: "local", state: "idle", space: { cwd: "" } };
  window.wb = { conversations: { get: async (id: string) => {
    assert.equal(id, input.threadId);
    return visible ? { info, sendPrompt: async (_text: unknown, options: { clientRequestId: string }) => {
      sends++;
      assert.equal(options.clientRequestId, input.deliveryId);
      return { disposition: "queued", item: { id: "native-item", clientRequestId: input.deliveryId } };
    } } : undefined;
  } } };
  assert.equal(await lookup(), "loading");
  visible = true;
  assert.equal(await lookup(), "loading");
  info.space.cwd = "C:/Unrelated/One";
  assert.equal(await lookup(), "unavailable");
  info.space.cwd = input.workspace;
  assert.equal(await lookup(), "ready");
  assert.equal(sends, 0);

  const send = () => runInNewContext(workbuddyDesktopMessageExpression(input, "continue"), { window });
  info.space.cwd = "C:/Unrelated/One";
  assert.equal((await send()).state, "unavailable");
  info.space.cwd = input.workspace;
  info.transport = "cloud";
  assert.equal((await send()).state, "unavailable");
  assert.equal(sends, 0);

  info.transport = "local";
  assert.equal((await send()).state, "accepted");
  assert.equal(sends, 1);
});

test("a cold renderer lookup timeout leaves the exact continuation definitively unsent", async () => {
  const input = { threadId: "original", workspace: "C:/project", text: "private fixture prompt", deliveryId: "same-intent" };
  const signal = new AbortController().signal;
  const expressions: string[] = [];
  const result = await dispatchWorkbuddyDesktopMessage(input, signal, "continue", async expression => {
    expressions.push(expression);
    throw new Error("WorkBuddy renderer timed out: Runtime.evaluate.");
  });
  assert.deepEqual(result, { state: "unavailable", threadId: "original", deliveryId: "same-intent" });
  assert.equal(expressions.length, 1);
  assert.ok(!expressions[0].includes(input.text));
  assert.ok(!expressions[0].includes(input.deliveryId));
  assert.ok(!expressions[0].includes(".sendPrompt("));
});

test("a timeout after the continuation send boundary stays uncertain", async () => {
  const input = { threadId: "original", workspace: "C:/project", text: "private fixture prompt", deliveryId: "same-intent" };
  const signal = new AbortController().signal;
  const timeout = new Error("WorkBuddy renderer timed out: Runtime.evaluate.");
  const expressions: string[] = [];
  await assert.rejects(dispatchWorkbuddyDesktopMessage(input, signal, "continue", async expression => {
    expressions.push(expression);
    if (expressions.length === 1) return "ready";
    throw timeout;
  }), error => error === timeout);
  assert.equal(expressions.length, 2);
  assert.ok(!expressions[0].includes(input.text));
  assert.ok(expressions[1].includes(input.text));
  assert.ok(expressions[1].includes(".sendPrompt("));
});

test("the relay declines steer on an old connector and sends the typed action only to a compatible connector", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rabi-workbuddy-steer-"));
  const descriptor = path.join(dir, "relay.json");
  const create = () => assert.fail("a steer request must never create a chat");
  let stop = await serveWorkbuddyDesktopRelay(create, descriptor);
  try {
    const first = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(descriptor, JSON.stringify({ ...first, steer: true }));
    await assert.rejects(requestWorkbuddyDesktopSteer(input, undefined, descriptor), /不支持本版引导会话/);
    await assert.rejects(requestWorkbuddyDesktopMessage(input, "continue", undefined, descriptor), /不支持本版后台唤起原会话/);
    await stop();
    let calls = 0;
    const modes: string[] = [];
    stop = await serveWorkbuddyDesktopRelay(create, descriptor, async (actual, _signal, mode) => {
      calls++;
      modes.push(mode);
      assert.deepEqual(actual, input);
      return { state: "accepted", threadId: actual.threadId, deliveryId: actual.deliveryId };
    });
    await assert.rejects(requestWorkbuddyDesktopSteer(input, () => { throw new Error("authorization changed"); }, descriptor), /authorization changed/);
    assert.equal(calls, 0);
    const updated = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(descriptor, JSON.stringify({ ...updated, continuationContract: 1 }));
    await assert.rejects(requestWorkbuddyDesktopMessage(input, "continue", undefined, descriptor), /不支持本版后台唤起原会话/);
    assert.equal(calls, 0);
    await requestWorkbuddyDesktopSteer(input, undefined, descriptor);
    await writeFile(descriptor, JSON.stringify(updated));
    await requestWorkbuddyDesktopMessage(input, "continue", undefined, descriptor);
    assert.equal(calls, 2);
    assert.deepEqual(modes, ["steer", "continue"]);
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

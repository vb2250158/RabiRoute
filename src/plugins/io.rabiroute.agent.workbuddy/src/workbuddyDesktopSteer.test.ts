import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { requestWorkbuddyDesktopSteer, serveWorkbuddyDesktopRelay } from "./workbuddyDesktopRelay.js";
import { steerWorkbuddyDesktopExpression } from "./workbuddyDesktopSteer.js";
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
  const evaluate = async () => JSON.parse(JSON.stringify(await runInNewContext(steerWorkbuddyDesktopExpression(input), { window })));
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
    const receipt = await runInNewContext(steerWorkbuddyDesktopExpression(input), { window });
    assert.equal(receipt.state, "unknown");
    assert.equal(submitted, 1);
  }
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

test("the relay declines steer on an old connector and sends the typed action only to a compatible connector", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rabi-workbuddy-steer-"));
  const descriptor = path.join(dir, "relay.json");
  const create = () => assert.fail("a steer request must never create a chat");
  let stop = await serveWorkbuddyDesktopRelay(create, descriptor);
  try {
    const first = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(descriptor, JSON.stringify({ ...first, steer: true }));
    await assert.rejects(requestWorkbuddyDesktopSteer(input, undefined, descriptor), /不支持本版引导会话/);
    await stop();
    let calls = 0;
    stop = await serveWorkbuddyDesktopRelay(create, descriptor, async actual => {
      calls++;
      assert.deepEqual(actual, input);
      return { state: "accepted", threadId: actual.threadId, deliveryId: actual.deliveryId };
    });
    await assert.rejects(requestWorkbuddyDesktopSteer(input, () => { throw new Error("authorization changed"); }, descriptor), /authorization changed/);
    assert.equal(calls, 0);
    await requestWorkbuddyDesktopSteer(input, undefined, descriptor);
    assert.equal(calls, 1);
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

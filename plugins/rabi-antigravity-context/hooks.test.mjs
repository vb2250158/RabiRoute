import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_TYPE,
  handleAntigravityHookInput,
  readPromptFromTranscript,
  toManagerRequest
} from "./scripts/lib/rabi-manager-client.mjs";

const CONVERSATION_ID = "a1e8f5ce-7e09-47d2-833f-ea27f532810b";

/** Answer Manager requests from a scripted table instead of a live Manager. */
function stubManager(responses) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || "{}");
    calls.push({ url, body });
    const answer = responses(body);
    return {
      ok: answer.ok !== false,
      status: answer.status ?? 200,
      text: async () => JSON.stringify(answer.payload ?? {})
    };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; }
  };
}

test("the adapter tag is antigravity so the Manager routes the hook stream correctly", () => {
  assert.equal(AGENT_TYPE, "antigravity");
});

test("Antigravity event names are mapped onto the Manager vocabulary", () => {
  const base = { conversationId: CONVERSATION_ID };
  // PreInvocation is the only pre-turn event Antigravity offers, and the Manager
  // reads the prompt on UserPromptSubmit.
  assert.equal(toManagerRequest({ ...base, hook_event_name: "PreInvocation" }).eventName, "UserPromptSubmit");
  assert.equal(toManagerRequest({ ...base, hook_event_name: "PostToolUse" }).eventName, "PostToolUse");
  assert.equal(toManagerRequest({ ...base, hook_event_name: "Stop" }).eventName, "Stop");
  assert.equal(toManagerRequest({ ...base, hook_event_name: "PreToolUse" }).eventName, "PreToolUse");
});

test("the conversation id becomes the session id the Manager binds", () => {
  const request = toManagerRequest({ conversationId: CONVERSATION_ID, hook_event_name: "PreInvocation" });
  assert.equal(request.sessionId, CONVERSATION_ID);
  assert.equal(request.agentType, "antigravity");
});

test("the first workspace path is forwarded as the working directory", () => {
  const request = toManagerRequest({
    conversationId: CONVERSATION_ID,
    hook_event_name: "PreInvocation",
    workspacePaths: ["C:\\Work\\ExampleProject", "C:\\Work\\Other"]
  });
  assert.equal(request.cwd, "C:\\Work\\ExampleProject");
});

test("the prompt is read from the transcript because PreInvocation omits it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hook-prompt-"));
  const transcriptPath = path.join(root, "transcript_full.jsonl");
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", content: "an answer" }),
    JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", content: "the newest user turn" })
  ].join("\n"), "utf8");
  try {
    assert.equal(readPromptFromTranscript(transcriptPath), "the newest user turn");
    const request = toManagerRequest({ conversationId: CONVERSATION_ID, transcriptPath, hook_event_name: "PreInvocation" });
    // Without this the Manager would receive an empty prompt and skip binding.
    assert.equal(request.prompt, "the newest user turn");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit prompt wins over the transcript", () => {
  const request = toManagerRequest({
    conversationId: CONVERSATION_ID,
    hook_event_name: "PreInvocation",
    prompt: "explicit prompt"
  });
  assert.equal(request.prompt, "explicit prompt");
});

test("a missing transcript yields an empty prompt instead of throwing", () => {
  assert.equal(readPromptFromTranscript("C:\\does\\not\\exist.jsonl"), "");
  assert.equal(readPromptFromTranscript(""), "");
});

test("Manager context is injected as an Antigravity step, not additionalContext", async () => {
  const stub = stubManager(() => ({ payload: { data: { additionalContext: "[Rabi] persona context" } } }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "PreInvocation"
    }, { managerUrl: "http://127.0.0.1:1" });
    // Antigravity records injected steps with `source: SYSTEM_SDK`, which is how
    // an injected turn stays distinguishable from a real user turn.
    assert.deepEqual(output, { injectSteps: [{ userMessage: "[Rabi] persona context" }] });
  } finally {
    stub.restore();
  }
});

test("empty Manager context produces no injection at all", async () => {
  const stub = stubManager(() => ({ payload: { data: { additionalContext: "" } } }));
  try {
    assert.equal(
      await handleAntigravityHookInput({ conversationId: CONVERSATION_ID, hook_event_name: "PreInvocation" }, { managerUrl: "http://127.0.0.1:1" }),
      null
    );
  } finally {
    stub.restore();
  }
});

test("PreToolUse allows by returning an empty object, because empty means deny", async () => {
  const stub = stubManager(() => ({ payload: { data: {} } }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "PreToolUse",
      toolName: "run_command"
    }, { managerUrl: "http://127.0.0.1:1" });
    // An absent decision is a DENY in Antigravity, so the allow case must send
    // an explicit object rather than nothing.
    assert.deepEqual(output, {});
  } finally {
    stub.restore();
  }
});

test("PreToolUse carries a deny decision through unchanged", async () => {
  const stub = stubManager(() => ({
    payload: { data: { toolDecision: { permissionDecision: "deny", reason: "blocked by RabiRoute" } } }
  }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "PreToolUse",
      toolName: "run_command"
    }, { managerUrl: "http://127.0.0.1:1" });
    assert.equal(output.permissionDecision, "deny");
    assert.equal(output.permissionDecisionReason, "blocked by RabiRoute");
  } finally {
    stub.restore();
  }
});

test("a Manager outage does not block every tool call in the conversation", async () => {
  const stub = stubManager(() => ({ ok: false, status: 500, payload: { message: "manager down" } }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "PreToolUse",
      toolName: "run_command"
    }, { managerUrl: "http://127.0.0.1:1" });
    // Failing closed here would make a Manager restart look like a broken host.
    assert.deepEqual(output, {});
  } finally {
    stub.restore();
  }
});

test("a Manager outage during PreInvocation is surfaced so the turn cannot silently lose context", async () => {
  const stub = stubManager(() => ({ ok: false, status: 500, payload: { message: "manager down" } }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "PreInvocation"
    }, { managerUrl: "http://127.0.0.1:1" });
    assert.match(output.injectSteps[0].userMessage, /Manager 当前不可用/);
    assert.match(output.injectSteps[0].userMessage, /不得使用插件本地缓存补造上下文/);
  } finally {
    stub.restore();
  }
});

test("a Stop event routes follow-up reasons into an injected step", async () => {
  const stub = stubManager(() => ({
    payload: { data: { followup: { decision: "block", reason: "please finish the plan step" } } }
  }));
  try {
    const output = await handleAntigravityHookInput({
      conversationId: CONVERSATION_ID,
      hook_event_name: "Stop"
    }, { managerUrl: "http://127.0.0.1:1" });
    assert.match(output.injectSteps[0].userMessage, /please finish the plan step/);
  } finally {
    stub.restore();
  }
});

test("a Stop event with nothing to report injects nothing", async () => {
  const stub = stubManager(() => ({ payload: { data: {} } }));
  try {
    assert.equal(
      await handleAntigravityHookInput({ conversationId: CONVERSATION_ID, hook_event_name: "Stop" }, { managerUrl: "http://127.0.0.1:1" }),
      null
    );
  } finally {
    stub.restore();
  }
});

test("a payload without a conversation id is skipped rather than guessed", async () => {
  const stub = stubManager(() => ({ payload: { data: { additionalContext: "should never be fetched" } } }));
  try {
    // Guessing a conversation risks writing context into somebody else's
    // conversation, so the hook fails closed here.
    assert.equal(
      await handleAntigravityHookInput({ hook_event_name: "PreInvocation" }, { managerUrl: "http://127.0.0.1:1" }),
      null
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("an unknown event is ignored without contacting the Manager", async () => {
  const stub = stubManager(() => ({ payload: { data: {} } }));
  try {
    assert.equal(
      await handleAntigravityHookInput({ conversationId: CONVERSATION_ID, hook_event_name: "SomethingElse" }, { managerUrl: "http://127.0.0.1:1" }),
      null
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

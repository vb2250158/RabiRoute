import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  antigravityBrainRoot,
  antigravityTranscriptPath,
  readAntigravityReceipt,
  readAntigravityTranscript
} from "./antigravityReceipt.js";

type StepInput = {
  step_index: number;
  source: string;
  type: string;
  status?: string;
  content: string;
};

function step(input: StepInput): string {
  return JSON.stringify({
    step_index: input.step_index,
    source: input.source,
    type: input.type,
    status: input.status ?? "DONE",
    created_at: "2026-09-17T03:00:00Z",
    content: input.content
  });
}

/**
 * Create an isolated ANTIGRAVITY_DATA_HOME with one conversation transcript.
 * `brain` is appended under the data home, matching how the host lays it out.
 */
function makeTranscript(conversationId: string, lines: string[]): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-transcript-"));
  const env = { ANTIGRAVITY_DATA_HOME: root };
  const file = antigravityTranscriptPath(conversationId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { root, env };
}

test("the brain root honours the data-home override", () => {
  assert.equal(antigravityBrainRoot({ ANTIGRAVITY_DATA_HOME: "D:\\agy" }), path.join("D:\\agy", "brain"));
});

test("the transcript path follows the host layout", () => {
  const file = antigravityTranscriptPath("conv-1", { ANTIGRAVITY_DATA_HOME: "D:\\agy" });
  assert.equal(file, path.join("D:\\agy", "brain", "conv-1", ".system_generated", "logs", "transcript_full.jsonl"));
});

test("transcript parsing keeps the fields the receipt depends on", () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello there" }),
    step({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "hi" })
  ]);
  try {
    const steps = readAntigravityTranscript("conv-1", env);
    assert.equal(steps?.length, 2);
    assert.equal(steps?.[0]?.stepIndex, 0);
    assert.equal(steps?.[0]?.source, "USER_EXPLICIT");
    assert.equal(steps?.[1]?.content, "hi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed line is skipped instead of failing the whole read", () => {
  // The host may be appending while this runs, so a torn line is expected.
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "kept" }),
    '{"step_index": 1, "source": "MODEL"',
    step({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", content: "also kept" })
  ]);
  try {
    const steps = readAntigravityTranscript("conv-1", env);
    assert.equal(steps?.length, 2);
    assert.equal(steps?.[1]?.stepIndex, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing transcript reads as null rather than throwing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-missing-"));
  try {
    assert.equal(readAntigravityTranscript("absent", { ANTIGRAVITY_DATA_HOME: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt is found once the prompt lands in the transcript", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Rabi message about the plan" })
  ]);
  try {
    const receipt = await readAntigravityReceipt(
      "conv-1",
      { needle: "Rabi message about the plan", timeoutMs: 200 },
      env
    );
    assert.equal(receipt.found, true);
    assert.equal(receipt.stepIndex, 0);
    assert.equal(receipt.source, "USER_EXPLICIT");
    assert.equal(receipt.modelReplied, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a system-message delivery is recognised as such", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "async notification body" })
  ]);
  try {
    const receipt = await readAntigravityReceipt("conv-1", { needle: "async notification body", timeoutMs: 200 }, env);
    assert.equal(receipt.found, true);
    // The identity difference between the two entry points is worth preserving
    // in the receipt: it is the only way to tell the semantics apart later.
    assert.equal(receipt.source, "SYSTEM");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a model reply after the prompt marks the receipt as answered", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "question text here" }),
    step({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "the model answer" })
  ]);
  try {
    const receipt = await readAntigravityReceipt("conv-1", { needle: "question text here", timeoutMs: 200 }, env);
    assert.equal(receipt.found, true);
    assert.equal(receipt.modelReplied, true);
    assert.equal(receipt.modelText, "the model answer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reply that precedes the prompt is not counted as its answer", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", content: "earlier answer" }),
    step({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", content: "later question text" })
  ]);
  try {
    const receipt = await readAntigravityReceipt("conv-1", { needle: "later question text", timeoutMs: 200 }, env);
    assert.equal(receipt.found, true);
    assert.equal(receipt.modelReplied, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("initialNumSteps stops an identical earlier delivery from being matched", async () => {
  // Re-sending the same text is the exact case that would otherwise produce a
  // false receipt: the needle is present, but from a turn before this one.
  const text = "the very same message text";
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: text })
  ]);
  try {
    const receipt = await readAntigravityReceipt(
      "conv-1",
      { needle: text, initialNumSteps: 1, timeoutMs: 250, intervalMs: 50 },
      env
    );
    assert.equal(receipt.found, false);
    assert.equal(receipt.totalSteps, 1);
    assert.match(receipt.reason, /No matching prompt appeared/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("initialNumSteps accepts a delivery that lands at or after the boundary", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "earlier turn" }),
    step({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", content: "fresh delivery text" })
  ]);
  try {
    const receipt = await readAntigravityReceipt(
      "conv-1",
      { needle: "fresh delivery text", initialNumSteps: 1, timeoutMs: 200 },
      env
    );
    assert.equal(receipt.found, true);
    assert.equal(receipt.stepIndex, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matching uses only the leading characters so long prompts still match", async () => {
  const needle = "a".repeat(120);
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: needle })
  ]);
  try {
    const receipt = await readAntigravityReceipt(
      "conv-1",
      { needle: `${"a".repeat(120)} and a tail that differs`, timeoutMs: 200 },
      env
    );
    assert.equal(receipt.found, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing transcript reports the conversation explicitly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-noreceipt-"));
  try {
    const receipt = await readAntigravityReceipt(
      "never-existed",
      { needle: "anything", timeoutMs: 100, intervalMs: 20 },
      { ANTIGRAVITY_DATA_HOME: root }
    );
    assert.equal(receipt.found, false);
    assert.equal(receipt.totalSteps, 0);
    assert.match(receipt.reason, /No transcript was readable for conversation never-existed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt is found when the transcript appears during the poll window", async () => {
  // Delivery is async, so the write can land after the first read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-late-"));
  const env = { ANTIGRAVITY_DATA_HOME: root };
  const conversationId = "conv-late";
  try {
    const pending = readAntigravityReceipt(
      conversationId,
      { needle: "arrives later", timeoutMs: 2_000, intervalMs: 40 },
      env
    );
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    const file = antigravityTranscriptPath(conversationId, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "arrives later" })}\n`,
      "utf8"
    );
    const receipt = await pending;
    assert.equal(receipt.found, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty needle cannot match every step", async () => {
  const { root, env } = makeTranscript("conv-1", [
    step({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "anything" })
  ]);
  try {
    const receipt = await readAntigravityReceipt("conv-1", { needle: "   ", timeoutMs: 100, intervalMs: 20 }, env);
    assert.equal(receipt.found, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

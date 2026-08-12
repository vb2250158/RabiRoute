import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexThreadCreationBlockedError,
  createCodexThreadWithReservation,
  readCodexThreadCreationReservationForTest
} from "./codexThreadCreationReservations.js";

function fixture(t: test.TestContext): { rootDir: string; workspace: string; title: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-create-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, workspace: path.join(rootDir, "workspace"), title: "持久创建测试" };
}

test("Codex thread creation persists every stage and returns the completed receipt after restart", async (t) => {
  const { rootDir, workspace, title } = fixture(t);
  const stages: string[] = [];
  let createCount = 0;
  const create = async (onStage: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void) => {
    createCount += 1;
    const threadId = "019f0000-0000-7000-8000-000000000201";
    onStage("thread_created", threadId);
    stages.push(readCodexThreadCreationReservationForTest(rootDir, title, workspace)?.state || "missing");
    onStage("naming", threadId);
    stages.push(readCodexThreadCreationReservationForTest(rootDir, title, workspace)?.state || "missing");
    onStage("initial_turn", threadId);
    stages.push(readCodexThreadCreationReservationForTest(rootDir, title, workspace)?.state || "missing");
    return {
      id: threadId,
      title,
      updatedAt: "2026-08-12T00:00:00.000Z",
      source: "test",
      initialTurnStatus: "started" as const
    };
  };

  const first = await createCodexThreadWithReservation({ rootDir, title, workspace, create });
  const afterRestart = await createCodexThreadWithReservation({
    rootDir,
    title,
    workspace,
    create: async () => { throw new Error("must not create again"); }
  });

  assert.equal(createCount, 1);
  assert.equal(afterRestart.id, first.id);
  assert.deepEqual(stages, ["thread_created", "naming", "initial_turn"]);
  assert.equal(readCodexThreadCreationReservationForTest(rootDir, title, workspace)?.state, "completed");
});

test("Codex thread creation keeps a thread-start acknowledgement uncertain and never starts twice", async (t) => {
  const { rootDir, workspace, title } = fixture(t);
  let createCount = 0;
  await assert.rejects(createCodexThreadWithReservation({
    rootDir,
    title,
    workspace,
    create: async (onStage) => {
      createCount += 1;
      onStage("thread_created", "019f0000-0000-7000-8000-000000000202");
      throw new Error("thread/name/set response was lost");
    }
  }), CodexThreadCreationBlockedError);

  const uncertain = readCodexThreadCreationReservationForTest(rootDir, title, workspace);
  assert.equal(uncertain?.state, "uncertain");
  assert.equal(uncertain?.threadId, "019f0000-0000-7000-8000-000000000202");

  await assert.rejects(createCodexThreadWithReservation({
    rootDir,
    title,
    workspace,
    create: async () => {
      createCount += 1;
      throw new Error("must not create again");
    }
  }), (error: unknown) => {
    assert.ok(error instanceof CodexThreadCreationBlockedError);
    assert.equal(error.reservation.state, "uncertain");
    return true;
  });
  assert.equal(createCount, 1);
});

test("Codex thread creation key treats extended and normal Windows paths as the same workspace", async (t) => {
  const { rootDir, title } = fixture(t);
  const normal = "C:\\Data\\CottonProject\\RabiRoute";
  const extended = "\\\\?\\C:\\Data\\CottonProject\\RabiRoute";
  let createCount = 0;
  const first = await createCodexThreadWithReservation({
    rootDir,
    title,
    workspace: normal,
    create: async () => {
      createCount += 1;
      return {
        id: "019f0000-0000-7000-8000-000000000203",
        title,
        updatedAt: "2026-08-12T00:00:00.000Z",
        source: "test",
        initialTurnStatus: "not-requested" as const
      };
    }
  });
  const duplicate = await createCodexThreadWithReservation({
    rootDir,
    title,
    workspace: extended,
    create: async () => { throw new Error("must not create again"); }
  });
  assert.equal(createCount, 1);
  assert.equal(duplicate.id, first.id);
});

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareCodexDesktopQueue } from "./codexDesktopQueue.js";

const input = { threadId: "fixture-thread", cwd: os.tmpdir(),
  rolloutPath: path.join(os.homedir(), ".codex", "sessions", "fixture.jsonl"), prompt: 'fixture "quoted"\n中文' };
const owner = { exe: path.resolve("fixtures", "codex.exe"), pid: 123, started: "2026-01-01T00:00:00Z" };

test("queue probes the running owner's CLI and supplies a single intact prompt", async () => {
  const commands: string[][] = [];
  const submit = await prepareCodexDesktopQueue(input, {
    platform: "win32", findOwner: async () => owner,
    run: async (exe, args) => {
      assert.equal(exe, owner.exe);
      commands.push(args);
      return { stdout: "Usage: codex queue --thread --message" };
    }
  });
  assert.deepEqual(commands, [["queue", "--help"]]);
  await submit(() => {});
  assert.deepEqual(commands[1], ["queue", "--thread", input.threadId, "--message=" + input.prompt]);
});

test("missing queue help, changed owner, and oversized prompt never enqueue", async () => {
  const calls: string[][] = [];
  let liveOwner = owner;
  let help = "";
  const deps = { platform: "win32", findOwner: async () => liveOwner, run: async (_exe: string, args: string[]) => {
    calls.push(args);
    return { stdout: help };
  } };
  await assert.rejects(prepareCodexDesktopQueue(input, deps), /does not advertise/);
  await assert.rejects(prepareCodexDesktopQueue({ ...input, prompt: "a".repeat(32_768) }, deps), /command line/);
  help = "Usage: codex queue --thread --message";
  const submit = await prepareCodexDesktopQueue(input, deps);
  liveOwner = { ...owner, pid: owner.pid + 1 };
  await assert.rejects(submit(() => {}), /owner changed/);
  assert.deepEqual(calls, [["queue", "--help"], ["queue", "--help"]]);
});

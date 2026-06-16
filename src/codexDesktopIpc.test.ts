import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseAppServerFallbackFor } from "./codexDesktopIpc.js";

test("Codex Desktop IPC falls back when the bound thread has no desktop client", () => {
  const previous = process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
  try {
    delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;

    assert.equal(
      shouldUseAppServerFallbackFor(
        new Error("Codex Desktop IPC turn failed: no-client-found"),
        { monitorThreadId: "thread-1", monitorThreadName: "MonsterGirl / 伊莉娅 策划美术" }
      ),
      true
    );
  } finally {
    if (previous == null) {
      delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    } else {
      process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK = previous;
    }
  }
});

test("Codex Desktop IPC app-server fallback can be disabled", () => {
  const previous = process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
  try {
    process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK = "0";

    assert.equal(
      shouldUseAppServerFallbackFor(new Error("Codex Desktop IPC turn failed: no-client-found"), {}),
      false
    );
  } finally {
    if (previous == null) {
      delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    } else {
      process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK = previous;
    }
  }
});

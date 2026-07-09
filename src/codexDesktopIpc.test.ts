import assert from "node:assert/strict";
import test from "node:test";
import {
  codexStateStillPointsToTargetThreadForTest,
  formatCodexDesktopDeliveryError,
  shouldUseAppServerFallbackFor
} from "./codexDesktopIpc.js";

test("Codex Desktop IPC falls back through app-server when a bound thread is unloaded by default", () => {
  const previous = process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
  const previousNoClientFallback = process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT;
  try {
    delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    delete process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT;

    assert.equal(
      shouldUseAppServerFallbackFor(
        new Error("Codex Desktop IPC turn failed: no-client-found"),
        { monitorThreadId: "thread-1", monitorThreadName: "MonsterGirl / 伊莉娅 策划美术" }
      ),
      true
    );

    assert.match(
      formatCodexDesktopDeliveryError(
        new Error("Codex Desktop IPC turn failed: no-client-found"),
        { monitorThreadId: "thread-1", monitorThreadName: "MonsterGirl / 伊莉娅 策划美术" }
      ),
      /启动\/聚焦 Codex App/
    );
  } finally {
    if (previous == null) {
      delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    } else {
      process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK = previous;
    }
    if (previousNoClientFallback == null) {
      delete process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT;
    } else {
      process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT = previousNoClientFallback;
    }
  }
});

test("Codex Desktop IPC no-client fallback can be explicitly disabled", () => {
  const previous = process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
  const previousNoClientFallback = process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT;
  try {
    delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT = "0";

    assert.equal(
      shouldUseAppServerFallbackFor(
        new Error("Codex Desktop IPC turn failed: no-client-found"),
        { monitorThreadId: "thread-1", monitorThreadName: "MonsterGirl / 伊莉娅 策划美术" }
      ),
      false
    );
  } finally {
    if (previous == null) {
      delete process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK;
    } else {
      process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK = previous;
    }
    if (previousNoClientFallback == null) {
      delete process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT;
    } else {
      process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT = previousNoClientFallback;
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

test("Codex Desktop IPC stale cached thread id does not override a newer same-name session index record", () => {
  assert.equal(
    codexStateStillPointsToTargetThreadForTest(
      {
        monitorThreadId: "old-thread",
        monitorThreadName: "夜雨会话",
        monitorThreadUpdatedAt: "2026-06-10T14:46:49.151Z"
      },
      [{
        id: "new-thread",
        threadName: "夜雨会话",
        updatedAt: "2026-07-05T08:25:45.000Z",
        source: "session_index.jsonl"
      }],
      "夜雨会话"
    ),
    false
  );
});

test("Codex Desktop IPC keeps a cached thread only when no replacement exists in session index", () => {
  assert.equal(
    codexStateStillPointsToTargetThreadForTest(
      {
        monitorThreadId: "old-thread",
        monitorThreadName: "夜雨会话"
      },
      [{
        id: "other-thread",
        threadName: "别的会话",
        updatedAt: "2026-07-05T08:25:45.000Z",
        source: "session_index.jsonl"
      }],
      "夜雨会话"
    ),
    true
  );
});

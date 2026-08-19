import assert from "node:assert/strict";
import test from "node:test";

import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import {
  resolveDeliveredMessageProcessingTarget,
  resolveMessageProcessingDeliveryTarget
} from "./messageProcessingDeliveryTarget.js";

type Worker = NonNullable<MessageProcessingRequirement["worker"]>;

const messageWorker: Worker = {
  threadId: "message-thread",
  threadName: "人格 协助处理消息1",
  workspace: "C:/workspace"
};

function gateway(overrides: Partial<GatewayDefinition> = {}): GatewayDefinition {
  return {
    id: "main",
    configName: "main",
    gatewayPort: 8789,
    agentAdapters: ["codex"],
    primaryAgentAdapter: "codex",
    codexThreadId: "primary-thread",
    codexThreadName: "主人格",
    codexCwd: "C:/workspace",
    messageProcessingAgents: {
      codex: {
        enabled: false,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    },
    ...overrides
  } as GatewayDefinition;
}

test("disabled message processing routes follow-up work to the primary persona", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway(), messageWorker), {
    agentType: "primary_persona",
    worker: {
      threadId: "primary-thread",
      threadName: "主人格",
      workspace: "C:/workspace"
    }
  });
});

test("enabled message processing keeps follow-up work on the managed worker", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway({
    messageProcessingAgents: {
      codex: {
        enabled: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    }
  }), messageWorker), {
    agentType: "message_processing",
    worker: messageWorker
  });
});

test("a DSH primary never reuses a persisted Codex message-processing worker", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway({
    agentAdapters: ["codex", "dsh"],
    primaryAgentAdapter: "dsh",
    dshSessionId: "session-b9a5c9bf-8e96-4fad-9035-9c6d3d25b682",
    dshSessionName: "DSH 主人格",
    dshCwd: "C:/workspace",
    messageProcessingAgents: {
      codex: {
        enabled: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    }
  }), messageWorker), {
    agentType: "primary_persona",
    worker: {
      threadId: "session-b9a5c9bf-8e96-4fad-9035-9c6d3d25b682",
      threadName: "DSH 主人格",
      workspace: "C:/workspace"
    }
  });
});

test("disabled message processing does not silently select a non-Codex primary adapter", () => {
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({
    agentAdapters: ["codex", "copilotCli"],
    primaryAgentAdapter: "copilotCli"
  }), messageWorker), undefined);
});

test("disabled message processing requires a complete primary persona binding", () => {
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({ codexThreadId: "" }), messageWorker), undefined);
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({ codexCwd: "" }), messageWorker), undefined);
});

test("a delivered archived-task replacement keeps the role and adopts the new task binding", () => {
  const target = resolveMessageProcessingDeliveryTarget(gateway(), messageWorker);
  assert.ok(target);
  assert.deepEqual(resolveDeliveredMessageProcessingTarget(target, {
    previousThreadId: "primary-thread",
    threadId: "replacement-thread",
    thread: {
      id: "replacement-thread",
      title: "主人格",
      cwd: "C:/workspace"
    }
  }), {
    previousThreadId: "primary-thread",
    target: {
      agentType: "primary_persona",
      worker: {
        threadId: "replacement-thread",
        threadName: "主人格",
        workspace: "C:/workspace"
      }
    }
  });
});

test("an unchanged delivery target does not report a replacement", () => {
  const target = resolveMessageProcessingDeliveryTarget(gateway(), messageWorker);
  assert.ok(target);
  assert.deepEqual(resolveDeliveredMessageProcessingTarget(target, {
    threadId: "primary-thread"
  }), { target });
});

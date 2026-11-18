import assert from "node:assert/strict";
import test from "node:test";

import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { remoteAgentTargetKey } from "../shared/routeAgentTargets.js";
import {
  resolveDeliveredMessageProcessingTarget,
  resolveMessageProcessingDeliveryTarget as resolveTarget
} from "./messageProcessingDeliveryTarget.js";

type Worker = NonNullable<MessageProcessingRequirement["worker"]>;

function resolveMessageProcessingDeliveryTarget(definition: GatewayDefinition, worker: Worker | undefined) {
  return resolveTarget(definition, worker, (route, adapter) => {
    if (adapter === "codex") return { sessionId: route.codexThreadId, sessionName: route.codexThreadName, workspace: route.codexCwd };
    if (adapter === "dsh") return { sessionId: route.dshSessionId, sessionName: route.dshSessionName, workspace: route.dshCwd };
    return undefined;
  });
}

const messageWorker: Worker = {
  threadId: "message-thread",
  threadName: "角色 协助处理消息1",
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
    codexThreadName: "主角色",
    codexCwd: "C:/workspace",
    messageProcessingAgents: {},
    ...overrides
  } as GatewayDefinition;
}

test("unconfigured message processing routes follow-up work to the primary persona", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway(), messageWorker), {
    agentType: "primary_persona",
    worker: {
      agentAdapter: "codex",
      threadId: "primary-thread",
      threadName: "主角色",
      workspace: "C:/workspace"
    }
  });
});

test("configured message processing keeps follow-up work despite a legacy disabled flag", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway({
    messageProcessingAgents: {
      codex: {
        enabled: false,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    }
  }), messageWorker), {
    agentType: "message_processing",
    worker: { ...messageWorker, agentAdapter: "codex" }
  });
});

test("DSH default follow-ups use its primary session without borrowing a managed worker", () => {
  const dsh = gateway({
    agentAdapters: ["codex", "dsh"], primaryAgentAdapter: "dsh",
    dshSessionId: "session-b9a5c9bf-8e96-4fad-9035-9c6d3d25b682", dshCwd: "C:/workspace",
    messageProcessingAgents: { dsh: { enabled: false, model: "example", reasoningEffort: "medium" } }
  });
  for (const worker of [undefined, messageWorker]) {
    const target = resolveMessageProcessingDeliveryTarget(dsh, worker);
    assert.equal(target?.agentType, "primary_persona");
    assert.equal(target?.worker.threadId, dsh.dshSessionId);
    assert.equal(target?.worker.agentAdapter, "dsh");
  }
});

test("message processing rejects a worker outside the Primary Persona workspace", () => {
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({
    messageProcessingAgents: {
      codex: {
        enabled: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium"
      }
    }
  }), {
    ...messageWorker,
    workspace: "C:/other-workspace"
  }), undefined);
});
test("a DSH primary never reuses a persisted Codex message-processing worker", () => {
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(gateway({
    agentAdapters: ["codex", "dsh"],
    primaryAgentAdapter: "dsh",
    dshSessionId: "session-b9a5c9bf-8e96-4fad-9035-9c6d3d25b682",
    dshSessionName: "DSH 主角色",
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
      agentAdapter: "dsh",
      threadId: "session-b9a5c9bf-8e96-4fad-9035-9c6d3d25b682",
      threadName: "DSH 主角色",
      workspace: "C:/workspace"
    }
  });
});

test("unconfigured message processing does not silently select a non-Codex primary adapter", () => {
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({
    agentAdapters: ["codex", "copilotCli"],
    primaryAgentAdapter: "copilotCli"
  }), messageWorker), undefined);
});

test("unconfigured message processing requires a complete primary persona binding", () => {
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({ codexThreadId: "" }), messageWorker), undefined);
  assert.equal(resolveMessageProcessingDeliveryTarget(gateway({ codexCwd: "" }), messageWorker), undefined);
});

test("default follow-up selects the remote primary owner even when a local task has the same provider", () => {
  const instanceBinding = { instanceId: "remote-computer", agentId: "remote-codex", ownerDeviceId: "peer-owner" };
  const id = remoteAgentTargetKey(instanceBinding);
  const definition = gateway({ primaryAgentTarget: id, remoteAgentTargets: [{
    ...instanceBinding, id, provider: "codex", sessionId: "remote-thread", sessionName: "Remote", workspace: "D:/remote"
  }] });
  assert.deepEqual(resolveMessageProcessingDeliveryTarget(definition, undefined), {
    agentType: "primary_persona", instanceBinding,
    worker: { agentAdapter: "codex", threadId: "remote-thread", threadName: "Remote", workspace: "D:/remote" }
  });
});

test("a delivered archived-task replacement keeps the role and adopts the new task binding", () => {
  const target = resolveMessageProcessingDeliveryTarget(gateway(), messageWorker);
  assert.ok(target);
  assert.deepEqual(resolveDeliveredMessageProcessingTarget(target, {
    previousThreadId: "primary-thread",
    threadId: "replacement-thread",
    thread: {
      id: "replacement-thread",
      title: "主角色",
      cwd: "C:/workspace"
    }
  }), {
    previousThreadId: "primary-thread",
    target: {
      agentType: "primary_persona",
      worker: {
        agentAdapter: "codex",
        threadId: "replacement-thread",
        threadName: "主角色",
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

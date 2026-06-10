import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentReply, type AgentReplyOptions } from "./outbox.js";

function optionsWithRuntime(runtime: AgentReplyOptions["runtimes"][number]): AgentReplyOptions {
  return {
    rootDir: process.cwd(),
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [runtime]
  };
}

test("Codex output adapter accepts replies without turning them into drafts", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "accepted by codex"
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "codex",
      outputPipeline: "codex"
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Accepted by Codex output adapter.");
});

test("QQ output does not require original source context when target is explicit", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "explicit private target",
    targetType: "private",
    userId: "10001"
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "qq",
      outputPipeline: "qq"
    },
    messageAdapterPolicies: {
      napcat: {
        outputEnabled: true,
        supportedOutputs: ["text"]
      }
    },
    napcatInstances: []
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
});

test("explicit group target can proactively use NapCat even when pipeline is codex", async () => {
  const result = await handleAgentReply({
    text: "项目进度提醒：请同步当前阻塞。",
    routeProfileId: "其他路由",
    targetType: "group",
    groupId: "20002"
  }, {
    rootDir: process.cwd(),
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [
      {
        id: "AIPM群",
        targetGroupId: "20002",
        pipeline: {
          outputAdapter: "codex",
          outputPipeline: "codex",
          replyToSource: false
        },
        messageAdapterPolicies: {
          napcat: ({
            outputEnabled: true,
            outputMode: "draft",
            supportedOutputs: ["text"],
            allowedGroups: ["10001"],
            disabledPipelines: ["codex"]
          } as any)
        },
        napcatInstances: []
      },
      {
        id: "其他路由",
        targetGroupId: "30003",
        napcatInstances: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
  assert.equal(result.routeProfileId, "AIPM群");
  assert.equal(result.targetType, "group");
  assert.equal(result.groupId, "20002");
});

test("source reply resolves runtime route from message log and bypasses codex output pipeline", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-"));
  const routeDir = path.join(rootDir, "data", "route", "宇宙程序");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, "private-messages.jsonl"), `${JSON.stringify({
    time: 1,
    messageId: "private-1",
    userId: "10001",
    instanceId: "main-qq",
    adapterType: "napcat",
    botUserId: "99999",
    rawMessage: "推进一下项目进度"
  })}\n`, "utf8");

  const result = await handleAgentReply({
    text: "收到，我来推进。",
    replyContext: {
      routeProfileId: "programmer",
      routeKind: "private",
      targetType: "private",
      messageId: "private-1",
      userId: "10001",
      instanceId: "main-qq",
      outputAdapter: "codex",
      outputPipeline: "codex",
      replyToSource: false
    }
  }, {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [
      {
        id: "宇宙程序",
        dataDir: path.join("data", "route", "宇宙程序"),
        pipeline: {
          outputAdapter: "codex",
          outputPipeline: "codex",
          replyToSource: false
        },
        messageAdapterPolicies: {
          napcat: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        },
        napcatInstances: []
      },
      {
        id: "其他路由",
        dataDir: path.join("data", "route", "其他路由"),
        pipeline: {
          outputAdapter: "qq",
          outputPipeline: "qq"
        },
        napcatInstances: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
  assert.equal(result.routeProfileId, "宇宙程序");
  assert.equal(result.targetType, "private");
  assert.equal(result.userId, "10001");
  assert.equal(result.instanceId, "main-qq");
});

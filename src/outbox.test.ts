import assert from "node:assert/strict";
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
        outputMode: "replyOnly",
        supportedOutputs: ["text"]
      }
    },
    napcatInstances: []
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { config, type RouteProfile } from "./config.js";
import { forwardMessageAndWait } from "./forwarding.js";
import type { GroupMessageRecord } from "./history.js";
import { resolvePipeline } from "./pipelines.js";

type ForwardingConfigPatch = Partial<Pick<typeof config,
  "agentAdapters"
  | "agentRoleFile"
  | "agentRoleId"
  | "codexDesktopIpcNotify"
  | "codexDirectNotify"
  | "dataDir"
  | "memoryDataDir"
  | "routeProfiles"
  | "rolesDir"
>>;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-forwarding-"));
}

function groupMessage(patch: Partial<GroupMessageRecord> = {}): GroupMessageRecord {
  return {
    time: 1710000000,
    groupId: 10001,
    userId: 42,
    rawMessage: "[CQ:at,qq=12345] hello",
    messageId: "msg-1",
    senderName: "Alice",
    ...patch
  };
}

function routeProfile(root: string, patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "main",
    name: "Main route",
    enabled: true,
    resolvedPipeline: resolvePipeline("qq_chat"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.join(root, "roles"),
    dataDir: path.join(root, "route-data"),
    routeVariables: {},
    notificationRules: [],
    ...patch
  };
}

async function withForwardingConfig<T>(patch: ForwardingConfigPatch, run: () => Promise<T> | T): Promise<T> {
  const previous: Required<ForwardingConfigPatch> = {
    agentAdapters: config.agentAdapters,
    agentRoleFile: config.agentRoleFile,
    agentRoleId: config.agentRoleId,
    codexDesktopIpcNotify: config.codexDesktopIpcNotify,
    codexDirectNotify: config.codexDirectNotify,
    dataDir: config.dataDir,
    memoryDataDir: config.memoryDataDir,
    routeProfiles: config.routeProfiles,
    rolesDir: config.rolesDir
  };
  Object.assign(config, patch);
  try {
    return await run();
  } finally {
    Object.assign(config, previous);
  }
}

test("forwardMessageAndWait returns missed when no route profile is active", async () => {
  const root = tempDir();
  await withForwardingConfig({
    agentAdapters: [],
    codexDesktopIpcNotify: false,
    codexDirectNotify: false,
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: []
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_active_route_profile");
    assert.equal(result.matchedRuleCount, 0);
    assert.equal(result.sentPacketCount, 0);
    assert.deepEqual(result.routes, []);
  });
});

test("forwardMessageAndWait returns route miss details when no rule matches", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    codexDesktopIpcNotify: false,
    codexDirectNotify: false,
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("group_message", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_matching_rule");
    assert.equal(result.routes[0].routeId, "main");
    assert.equal(result.routes[0].status, "missed");
    assert.equal(result.routes[0].reason, "no_matching_rule");
    assert.deepEqual(result.routes[0].matchedRuleIds, []);
    assert.equal(result.sentPacketCount, 0);
  });
});

test("forwardMessageAndWait reports matched packets separately from adapter delivery", async () => {
  const root = tempDir();
  const routeDataDir = path.join(root, "roles", "Rabi");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    codexDesktopIpcNotify: false,
    codexDirectNotify: false,
    dataDir: path.join(root, "data"),
    memoryDataDir: routeDataDir,
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "routed");
    assert.equal(result.reason, "no_agent_adapter");
    assert.deepEqual(result.matchedRuleIds, ["direct"]);
    assert.equal(result.sentPacketCount, 1);
    assert.deepEqual(result.adapterOutcomes, []);

    const notificationLog = fs.readFileSync(path.join(routeDataDir, "codex-notifications.jsonl"), "utf8");
    assert.match(notificationLog, /matched/);
  });
});

test("forwardMessageAndWait surfaces adapter delivery failures", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    dataDir: path.join(root, "route-data"),
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: ["unsupported" as AgentAdapterType],
    codexDesktopIpcNotify: false,
    codexDirectNotify: false,
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "failed");
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.sentPacketCount, 1);
    assert.equal(result.adapterOutcomes.length, 1);
    assert.equal(result.adapterOutcomes[0].adapter, "unsupported");
    assert.equal(result.adapterOutcomes[0].status, "failed");
    assert.match(result.adapterOutcomes[0].error ?? "", /Unsupported agent adapter/);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePipeline } from "../pipelines.js";
import type { RouteProfile } from "../config.js";
import {
  collectScheduledAutomationTasks,
  executeScriptAutomation,
  matchingMessageScriptAutomations,
  resolvePersonaScript,
  type ScriptAutomationTask
} from "./personaAutomationRuntime.js";

function route(rolesDir: string, patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "Rabi__main",
    name: "Main",
    enabled: true,
    recentMessageLimit: 12,
    resolvedPipeline: resolvePipeline(),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir,
    routeVariables: {},
    automationRules: [],
    personaAutomationScriptsEnabled: false,
    notificationRules: [],
    ...patch
  };
}

test("scheduled automation collection keeps Agent and script actions under one trigger model", () => {
  const profile = route("C:\\roles", {
    automationRules: [{
      id: "agent-task",
      trigger: { type: "schedule", schedule: { id: "daily", type: "daily_time", timeOfDay: "09:00" } },
      action: { type: "deliver_agent", message: "review" }
    }, {
      id: "script-task",
      trigger: { type: "schedule", schedule: { id: "interval", type: "interval", intervalSeconds: 60 } },
      action: { type: "run_script", scriptPath: "check.py" }
    }]
  });

  assert.deepEqual(collectScheduledAutomationTasks([profile]).map(task => task.rule.id), ["agent-task", "script-task"]);
});

test("message script automation reuses Route matching rules", () => {
  const profile = route("C:\\roles", {
    automationRules: [{
      id: "build-script",
      trigger: { type: "message", routeKinds: ["private"], regex: "build failed" },
      action: { type: "run_script", scriptPath: "repair.cmd" }
    }]
  });

  assert.equal(matchingMessageScriptAutomations(profile, "private", {
    time: 1,
    userId: 2,
    rawMessage: "build failed on main"
  }, {}).length, 1);
  assert.equal(matchingMessageScriptAutomations(profile, "private", {
    time: 1,
    userId: 2,
    rawMessage: "hello"
  }, {}).length, 0);
});

test("persona script resolution requires local opt-in and blocks path escape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-automation-"));
  const rolesDir = path.join(root, "roles");
  const scriptsDir = path.join(rolesDir, "Rabi", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "check.py"), "print('ok')\n", "utf8");
  fs.writeFileSync(path.join(root, "outside.py"), "print('no')\n", "utf8");

  assert.throws(() => resolvePersonaScript(route(rolesDir), "check.py"), /未允许/);
  const enabled = route(rolesDir, { personaAutomationScriptsEnabled: true });
  assert.equal(resolvePersonaScript(enabled, "scripts/check.py").scriptPath, path.join(scriptsDir, "check.py"));
  assert.throws(() => resolvePersonaScript(enabled, "../outside.py"), /相对路径/);
});

test("Windows persona automation runs an approved cmd script and captures output", {
  skip: process.platform !== "win32"
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-automation-run-"));
  const rolesDir = path.join(root, "roles");
  const scriptsDir = path.join(rolesDir, "Rabi", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "check.cmd"), "@echo automation-ok\r\n", "utf8");
  const profile = route(rolesDir, {
    personaAutomationScriptsEnabled: true,
    automationRules: [{
      id: "script-run",
      trigger: { type: "message", routeKinds: ["private"] },
      action: { type: "run_script", scriptPath: "check.cmd", timeoutSeconds: 10 }
    }]
  });
  const rule = profile.automationRules?.[0];
  assert.ok(rule?.action.type === "run_script");

  const result = await executeScriptAutomation({ route: profile, rule } as ScriptAutomationTask);

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout || "", /automation-ok/);
});

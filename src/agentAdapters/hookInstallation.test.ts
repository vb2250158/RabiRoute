import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateAgentHooks, workbuddyHookPaths } from "./hookInstallation.js";

test("Codex installation is serialized and never removes other plugins", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); };
  const first = updateAgentHooks("test-codex", "codex", run);
  const duplicate = updateAgentHooks("test-codex", "codex", run);
  assert.equal(first, duplicate);
  await first;
  assert.deepEqual(calls.map(args => args.slice(0, 3)), [["plugin", "marketplace", "add"], ["plugin", "add", "rabi-codex-context@rabiroute-local"]]);
});

test("failed installation can be retried and DSH uses its own plugin manager", async () => {
  await assert.rejects(updateAgentHooks("test-failure", "codex", async () => { throw new Error("installer failed"); }), /installer failed/);
  await updateAgentHooks("test-failure", "codex", async () => {});
  const calls: string[][] = [];
  await updateAgentHooks("test-dsh", "dsh", async args => { calls.push(args); });
  assert.deepEqual(calls[0].slice(0, 4), ["plugin", "--profile", "web", "add"]);
  assert.match(calls[0][4], /rabi-dsh-context$/);
  await assert.rejects(updateAgentHooks("test-invalid", "unknown"), /安装包/);
});

/** Build the smallest shipped hook package the installer needs to read. */
function workbuddyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-wb-hook-"));
  const packageRoot = path.join(root, "dist", "agent-hooks", "plugins", "rabi-workbuddy-context");
  fs.mkdirSync(path.join(packageRoot, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "scripts", "rabi-workbuddy-hook.mjs"), "// hook entry\n");
  const entry = "node -e \"import(path.join(process.env.CODEBUDDY_PLUGIN_ROOT, 'scripts', 'rabi-workbuddy-hook.mjs'))\"";
  fs.writeFileSync(path.join(packageRoot, "hooks", "hooks.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: entry, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: entry, timeout: 10 }] }]
    }
  }));
  return root;
}

function withWorkbuddyPaths(root: string) {
  const previous = {
    hookRoot: process.env.RABI_WORKBUDDY_HOOK_ROOT,
    settings: process.env.RABI_WORKBUDDY_SETTINGS_FILE
  };
  process.env.RABI_WORKBUDDY_HOOK_ROOT = path.join(root, "install");
  process.env.RABI_WORKBUDDY_SETTINGS_FILE = path.join(root, "settings.json");
  return () => {
    for (const [key, value] of [["RABI_WORKBUDDY_HOOK_ROOT", previous.hookRoot], ["RABI_WORKBUDDY_SETTINGS_FILE", previous.settings]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
}

function ownCommands(settings: any): string[] {
  return Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
    .flatMap(groups => groups)
    .flatMap(group => group.hooks)
    .map(hook => hook.command)
    .filter(command => command.includes("rabi-workbuddy-hook.mjs"));
}

test("WorkBuddy hooks land in the user settings file without dropping the user's own hooks", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  const settingsFile = process.env.RABI_WORKBUDDY_SETTINGS_FILE as string;
  fs.writeFileSync(settingsFile, JSON.stringify({
    sandbox: { extraAllowWrite: ["~/example"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "bash my-own-hook.sh" }] }] }
  }, null, 2));

  const first = await updateAgentHooks(root, "workbuddy");
  assert.match(first.message, /WorkBuddy/);

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.sandbox, { extraAllowWrite: ["~/example"] }, "unrelated settings survive");
  const stopCommands = settings.hooks.Stop.flatMap((group: any) => group.hooks).map((hook: any) => hook.command);
  assert.ok(stopCommands.includes("bash my-own-hook.sh"), "a user hook on the same event is preserved");
  assert.ok(ownCommands(settings).length > 0, "our hooks are installed");

  // The plugin-root placeholder must be gone: a settings-level hook has no plugin root.
  const { installRoot } = workbuddyHookPaths();
  for (const command of ownCommands(settings)) {
    assert.doesNotMatch(command, /CODEBUDDY_PLUGIN_ROOT/);
    assert.ok(command.includes(JSON.stringify(installRoot)), `hook must point at ${installRoot}: ${command}`);
  }
  assert.ok(fs.existsSync(path.join(installRoot, "scripts", "rabi-workbuddy-hook.mjs")), "scripts are copied to the stable path");
});

test("re-running the WorkBuddy installer replaces its own hooks instead of stacking them", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  await updateAgentHooks(root, "workbuddy");
  const afterFirst = JSON.parse(fs.readFileSync(process.env.RABI_WORKBUDDY_SETTINGS_FILE as string, "utf8"));
  await updateAgentHooks(root, "workbuddy");
  const afterSecond = JSON.parse(fs.readFileSync(process.env.RABI_WORKBUDDY_SETTINGS_FILE as string, "utf8"));

  assert.equal(ownCommands(afterSecond).length, ownCommands(afterFirst).length);
  assert.deepEqual(ownCommands(afterSecond), ownCommands(afterFirst));
  assert.ok(afterSecond.hooks.SessionStart, "every declared event is materialized");
});

test("the WorkBuddy installer refuses to overwrite a settings file it cannot parse", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);
  fs.writeFileSync(process.env.RABI_WORKBUDDY_SETTINGS_FILE as string, "{ not json");

  await assert.rejects(updateAgentHooks(root, "workbuddy"), /不是有效的 JSON/);
});

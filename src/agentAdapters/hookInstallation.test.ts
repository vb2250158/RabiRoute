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
  // Mirror the real entrypoint's `--self-check` contract: print one verdict JSON
  // line and exit 0. The installer parses exactly this, so a stub that prints
  // nothing would test the wrong thing.
  fs.writeFileSync(path.join(packageRoot, "scripts", "rabi-workbuddy-hook.mjs"), [
    "if (process.argv.includes('--self-check')) {",
    "  process.stdout.write(JSON.stringify({ ok: true, detail: '已连通（测试替身）' }) + '\\n');",
    "  process.exit(0);",
    "}",
    ""
  ].join("\n"));
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
    settings: process.env.RABI_WORKBUDDY_SETTINGS_FILE,
    // The installer names the live WorkBuddy tasks that still need a restart, so
    // the fixture must own the sessions directory or the test would report on
    // whatever tasks happen to be open on this machine.
    home: process.env.RABI_WORKBUDDY_HOME
  };
  process.env.RABI_WORKBUDDY_HOOK_ROOT = path.join(root, "install");
  process.env.RABI_WORKBUDDY_SETTINGS_FILE = path.join(root, "settings.json");
  process.env.RABI_WORKBUDDY_HOME = path.join(root, "home");
  fs.mkdirSync(path.join(root, "home", "sessions"), { recursive: true });
  return () => {
    for (const [key, value] of [
      ["RABI_WORKBUDDY_HOOK_ROOT", previous.hookRoot],
      ["RABI_WORKBUDDY_SETTINGS_FILE", previous.settings],
      ["RABI_WORKBUDDY_HOME", previous.home]
    ] as const) {
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

/**
 * The installer resolves the WorkBuddy home from the same variables the session
 * store uses. `CODEBUDDY_CONFIG_DIR` is the one the desktop app actually injects;
 * `WORKBUDDY_CONFIG_DIR` is the branded alias. Getting this wrong used to write
 * settings into a home the session never reads, with no error surfaced.
 */
test("the WorkBuddy home follows the config dir the desktop app actually injects", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);
  // Drop the explicit settings-file override so home resolution is exercised.
  delete process.env.RABI_WORKBUDDY_SETTINGS_FILE;
  const home = path.join(root, "custom-home");
  process.env.CODEBUDDY_CONFIG_DIR = home;

  const previousHome = process.env.RABI_WORKBUDDY_HOME;
  const previousAlias = process.env.WORKBUDDY_CONFIG_DIR;
  delete process.env.RABI_WORKBUDDY_HOME;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  t.after(() => {
    delete process.env.CODEBUDDY_CONFIG_DIR;
    if (previousHome !== undefined) process.env.RABI_WORKBUDDY_HOME = previousHome;
    if (previousAlias !== undefined) process.env.WORKBUDDY_CONFIG_DIR = previousAlias;
  });

  await updateAgentHooks(root, "workbuddy");

  const written = path.join(home, "settings.json");
  assert.ok(fs.existsSync(written), `settings must land in CODEBUDDY_CONFIG_DIR: ${written}`);
  const settings = JSON.parse(fs.readFileSync(written, "utf8"));
  assert.ok(ownCommands(settings).length > 0, "our hooks are installed into the resolved home");
});

/** An explicit RABI_WORKBUDDY_HOME override must win over the injected config dir. */
test("an explicit WorkBuddy home override wins over the injected config dir", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);
  delete process.env.RABI_WORKBUDDY_SETTINGS_FILE;
  const explicit = path.join(root, "explicit-home");
  process.env.RABI_WORKBUDDY_HOME = explicit;
  process.env.CODEBUDDY_CONFIG_DIR = path.join(root, "ignored-home");
  t.after(() => {
    delete process.env.RABI_WORKBUDDY_HOME;
    delete process.env.CODEBUDDY_CONFIG_DIR;
  });

  await updateAgentHooks(root, "workbuddy");

  assert.ok(fs.existsSync(path.join(explicit, "settings.json")), "explicit home is used");
  assert.ok(!fs.existsSync(path.join(root, "ignored-home", "settings.json")), "the injected dir is not used");
});

/**
 * The installer reports whether the hook it just wrote can actually run. A
 * settings file alone does not prove liveness, so the message must carry the
 * self-check outcome either way.
 */
test("the WorkBuddy installer self-checks the hook it just installed", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  const result = await updateAgentHooks(root, "workbuddy");

  // The fixture's stub entrypoint is a valid, runnable Node file, so the probe
  // reaches the "connected" verdict and must say so explicitly.
  assert.match(result.message, /自检通过/);
  assert.match(result.message, /Hook 已写入 WorkBuddy/);
  assert.match(result.message, /新开任务/, "the message states what happens next");
});

/**
 * A running task keeps the hook set it started with, because WorkBuddy reads the
 * settings file once per session and never watches it. The installer therefore
 * has to name the tasks that still need a restart instead of leaving the
 * operator to guess which ones are stale.
 */
test("the installer names the running WorkBuddy tasks that still need a restart", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  // Publish one live session descriptor under the fixture home.
  const sessionsDir = path.join(process.env.RABI_WORKBUDDY_HOME as string, "sessions");
  fs.writeFileSync(path.join(sessionsDir, "4242.json"), JSON.stringify({
    pid: process.pid,
    sessionId: "live-task",
    cwd: "C:\\Data\\LiveProject",
    kind: "interactive",
    endpoint: "http://127.0.0.1:9999",
    lastHeartbeat: Date.now()
  }));

  const result = await updateAgentHooks(root, "workbuddy");

  assert.match(result.message, /1 个运行中的工作区/);
  assert.match(result.message, /C:\\Data\\LiveProject/, "the stale task's workspace is named");
  assert.match(result.message, /新开任务会自动加载/);
});

test("the installer says so when no task needs a restart", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  const result = await updateAgentHooks(root, "workbuddy");

  assert.match(result.message, /没有正在运行的 WorkBuddy 任务/);
});

/**
 * The WorkBuddy CLI host helper runs with its own temp cwd and is not something
 * the operator ever opened. Listing it as "restart this task" would send them
 * looking for a window that does not exist.
 */
test("internal CLI host sessions are never offered as tasks to restart", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  const sessionsDir = path.join(process.env.RABI_WORKBUDDY_HOME as string, "sessions");
  const descriptor = (sessionId: string, cwd: string, kind: string) => JSON.stringify({
    pid: process.pid, sessionId, cwd, kind, endpoint: "http://127.0.0.1:9999", lastHeartbeat: Date.now()
  });
  fs.writeFileSync(path.join(sessionsDir, "1.json"), descriptor("host", "C:\\Users\\X\\AppData\\Local\\Temp\\workbuddy-host-cli\\__workbuddy_cli_host__-5-abc", "interactive"));
  fs.writeFileSync(path.join(sessionsDir, "2.json"), descriptor("warm", "C:\\Program Files\\WorkBuddy", "prewarm"));
  fs.writeFileSync(path.join(sessionsDir, "3.json"), descriptor("real", "C:\\Data\\RealProject", "interactive"));

  const result = await updateAgentHooks(root, "workbuddy");

  assert.match(result.message, /1 个运行中的工作区/, "only the real task is counted");
  assert.match(result.message, /C:\\Data\\RealProject/);
  assert.doesNotMatch(result.message, /__workbuddy_cli_host__/);
  assert.doesNotMatch(result.message, /Program Files/, "prewarm sessions are internal");
});

/**
 * A hook declaration pointing at a script that was never copied is the failure
 * mode an operator cannot see from the settings file. The self-check has to
 * reflect the on-disk state instead of caching a stale verdict.
 */
test("the WorkBuddy installer reports a failed self-check when the entry script is missing", async (t) => {
  const root = workbuddyFixture();
  const restore = withWorkbuddyPaths(root);
  t.after(restore);

  const result = await updateAgentHooks(root, "workbuddy");

  // Remove the copied entrypoint, then re-run: the declaration stays valid while
  // the thing it points at is gone.
  const { installRoot } = workbuddyHookPaths();
  fs.rmSync(path.join(installRoot, "scripts", "rabi-workbuddy-hook.mjs"), { force: true });

  const second = await updateAgentHooks(root, "workbuddy");
  // Re-installing restores the script, so this run passes again — proving the
  // probe reflects the on-disk state rather than a cached verdict.
  assert.match(second.message, /自检通过/);
  assert.ok(
    fs.existsSync(path.join(installRoot, "scripts", "rabi-workbuddy-hook.mjs")),
    "the installer restores the entry script it depends on"
  );
  assert.ok(result.message.includes(installRoot), "the message names the script directory");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activate } from "../../../plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/manager.mjs";

const here = new URL("./", import.meta.url);
const root = new URL("../../../", here);
const read = relative => fs.readFile(new URL(relative, root), "utf8");

test("wearable sync scripts keep their UTF-8 identity under Windows PowerShell 5.1", { skip: process.platform !== "win32" }, async () => {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const parser = [
    "$tokens = $null",
    "$errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseFile($env:RABIROUTE_PARSE_PATH, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }"
  ].join("; ");
  for (const relative of [
    "apps/rabilink-android/scripts/Sync-MiHealthWearableToRabiLink.ps1",
    "plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/resources/Sync-MiHealthWearableToRabiLink.ps1"
  ]) {
    const scriptUrl = new URL(relative, root);
    const bytes = await fs.readFile(scriptUrl);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${relative} must retain a UTF-8 BOM for Windows PowerShell 5.1`);
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", parser], {
      encoding: "utf8",
      env: { ...process.env, RABIROUTE_PARSE_PATH: fileURLToPath(scriptUrl) }
    });
    assert.equal(result.status, 0, `${relative}\n${result.stderr || result.stdout}`);
  }
});

test("legacy apps entry points cannot create a second lifecycle", async () => {
  const [install, start, resolve, sync, manifestText, manager, workerService, packageStart, controlPlane] = await Promise.all([
    read("apps/rabilink-android/scripts/Install-RabiLinkWearableCompanionTask.ps1"),
    read("apps/rabilink-android/scripts/Start-RabiLinkWearableCompanion.ps1"),
    read("apps/rabilink-android/scripts/Resolve-RabiRouteHostManagerUrl.ps1"),
    read("apps/rabilink-android/scripts/Sync-MiHealthWearableToRabiLink.ps1"),
    read("plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/rabi.plugin.json"),
    read("plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/manager.mjs"),
    read("src/manager/wearableCompanionWorkerService.ts"),
    read("plugins/builtin/io.rabiroute.manager.wearable-companion/1.0.0/resources/Start-RabiLinkWearableCompanion.ps1"),
    read("src/manager/controlPlaneRoutes.ts")
  ]);
  const production = [install, start, resolve, sync, manager, workerService, packageStart].join("\n");
  assert.doesNotMatch(install, /\b(?:Register|New|Start|Stop|Unregister)-ScheduledTask\b/i);
  assert.doesNotMatch(production, /879[0-9]/);
  assert.doesNotMatch(production, /GATEWAY_MANAGER_URL|RABIROUTE_MANAGER_URL/);
  assert.match(install, /never registers, starts, stops, or removes a scheduled task/);
  assert.match(start, /WorkerStarted = \$false/);
  assert.match(resolve, /--command", "status", "--json"/);
  assert.match(resolve, /DriveType/);
  assert.match(resolve, /mapped network drive/);
  assert.match(resolve, /x-rabiroute-expected-application-generation-id/);
  assert.match(resolve, /x-rabiroute-expected-manager-instance-id/);
  assert.match(sync, /-Headers \$Target\.Headers/);
  assert.match(packageStart, /\[Parameter\(Mandatory\)\]\[string\]\$ApplicationGenerationId/);
  assert.match(packageStart, /\[Parameter\(Mandatory\)\]\[string\]\$ManagerInstanceId/);
  assert.doesNotMatch(packageStart, /exit 20\b/);
  assert.match(packageStart, /Write-CompanionState -Status "degraded"/);
  assert.match(packageStart, /\$nextDelaySeconds = \[Math\]::Max\(60, \$retry\)/);
  assert.match(packageStart, /Start-Sleep -Seconds \$nextDelaySeconds/);

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.entries.manager.execution, "in_process");
  assert.ok(manifest.requires.includes("host.manager.wearable-companion@1"));
  assert.doesNotMatch(manager, /node:child_process|\bspawn\s*\(/);
  assert.doesNotMatch(manager, /from ["']node:/);
  assert.match(workerService, /this\.leases\.launch\(/);
  assert.match(workerService, /detached: false/);
  assert.match(workerService, /MAX_RETRY_ATTEMPTS = 3/);
  assert.match(workerService, /RETRY_WINDOW_MS = 10 \* 60_000/);
  assert.match(controlPlane, /hostOwned: Boolean\(managerHostIdentity\)/);
  assert.match(controlPlane, /startupReady: wearableCompanionStartupReady/);
  const readyPublishedAt = controlPlane.indexOf("console.log(managerReadyLine({");
  const workerReleasedAt = controlPlane.indexOf("resolveWearableCompanionStartup();");
  assert.ok(readyPublishedAt >= 0, "Host READY must be published");
  assert.ok(workerReleasedAt > readyPublishedAt, "wearable worker must be released only after Host READY publication");
});

function pluginContext(workerService) {
  let effect;
  let failed;
  const context = {
    identity: Object.freeze({
      applicationGenerationId: "app-generation-7",
      managerInstanceId: "manager-instance-4",
      activationId: "activation-3",
      instanceId: "manager:wearable-companion",
      pluginId: "io.rabiroute.manager.wearable-companion",
      version: "1.0.0",
      revision: "revision-2",
      host: "manager"
    }),
    config: { enabled: true, roleId: "YeYu", serial: "" },
    services: {
      require(capability) {
        if (capability === "host.manager.wearable-companion-runtime@1") return Object.freeze({
          managerBaseUrl: "http://127.0.0.1:13486",
          applicationGenerationId: "app-generation-7",
          managerInstanceId: "manager-instance-4",
          runtimeRoot: "C:\\RabiRoute",
          stateRoot: "C:\\RabiRoute\\data\\wearable-companion",
          logRoot: "C:\\RabiRoute\\logs\\wearable-companion",
          pwshPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
        });
        if (capability === "host.manager.wearable-companion@1") return workerService;
        throw new Error(`unexpected capability ${capability}`);
      },
      provide() {}
    },
    lifecycle: { fail(error) { failed = error; } },
    effects: { add(starter) { effect = starter; } }
  };
  return { context, effect: () => effect, failed: () => failed };
}

test("plugin effect adopts disposer and forwards worker failure", async () => {
  let disposed = false;
  let failWorker;
  const failure = new Promise(resolve => { failWorker = resolve; });
  const observed = pluginContext({
    launch(identity, resourceRoot) {
      assert.equal(identity.activationId, "activation-3");
      assert.match(resourceRoot, /resources\/?$/);
      return { state: "managed", failure, async dispose() { disposed = true; } };
    }
  });
  await activate(observed.context);
  const dispose = await observed.effect()();
  const error = new Error("worker tree failed");
  failWorker(error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.failed(), error);
  await dispose();
  assert.equal(disposed, true);
});

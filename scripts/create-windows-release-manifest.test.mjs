import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeManifest } from "./create-windows-release-manifest.mjs";

function withPayload(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-release-manifest-"));
  try {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "RabiRouteHost.exe"), "host", "utf8");
    fs.writeFileSync(path.join(root, "dist", "manager.js"), "manager", "utf8");
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("release manifest is deterministic and gives same-version rebuilds distinct identities", () => {
  withPayload((root) => {
    const first = writeManifest(root, "0.2.1");
    fs.rmSync(path.join(root, "release-manifest.json"));
    const repeated = writeManifest(root, "0.2.1");
    assert.equal(repeated.releaseId, first.releaseId);
    assert.equal(repeated.payloadSha256, first.payloadSha256);
    assert.deepEqual(repeated.topLevelEntries, ["dist", "RabiRouteHost.exe"]);

    fs.writeFileSync(path.join(root, "dist", "manager.js"), "manager-v2", "utf8");
    fs.rmSync(path.join(root, "release-manifest.json"));
    const changed = writeManifest(root, "0.2.1");
    assert.notEqual(changed.releaseId, first.releaseId);
  });
});

test("release manifest refuses to replace a scoped runtime manifest", () => {
  withPayload((root) => {
    const destination = path.join(root, "release-manifest.json");
    const scopedManifest = JSON.stringify({ packageVersion: "0.0.0-host-core", files: [{ path: "RabiRouteHost.Core.dll" }] });
    fs.writeFileSync(destination, scopedManifest, "utf8");

    assert.throws(
      () => writeManifest(root, "0.2.1"),
      /Refusing to replace a pre-existing scoped manifest/
    );
    assert.equal(fs.readFileSync(destination, "utf8"), scopedManifest);
    assert.deepEqual(
      fs.readdirSync(root).filter((entry) => entry.startsWith("release-manifest.json.")),
      []
    );
  });
});

test("release manifest rejects runtime data and links", () => {
  withPayload((root) => {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "manager.json"), "{}", "utf8");
    assert.throws(() => writeManifest(root, "0.2.1"), /Runtime\/private path/);
  });

  if (process.platform !== "win32") {
    withPayload((root) => {
      fs.symlinkSync(path.join(root, "dist"), path.join(root, "linked-dist"));
      assert.throws(() => writeManifest(root, "0.2.1"), /symbolic link/);
    });
  }
});

test("release manifest rejects retired Manager semantics from built runtime and documentation", () => {
  for (const [relative, content] of [
    ["ribiwebgui/dist/assets/SettingsPage.js", "const state={managerPort:8790};"],
    ["dist/manager.js", "const state={\"managerPort\": \"8799\"};"],
    ["dist/manager/runtime.js", "const endpoint='http://localhost:8798';"],
    ["dist/managerEndpointPolicy.js", "const fallback = 8796;"],
    ["dist/config.js", "const managerUrl='http://192.168.1.20:8795';"],
    ["dist/config.js", "process.env.GATEWAY_MANAGER_PORT = '8794';"],
    ["dist/config.js", "const port = managerPort ?? 8792;"],
    ["scripts/start-manager.cmd", "node manager.js --managerPort 8797"],
    ["scripts/managerEndpoint.ps1", "$fallback = 8791"],
    ["ribiwebgui/dist/reports/speech.html", "<td>Manager 8790 回环接口</td>"],
    ["docs/current.md", "Open Manager at http://127.0.0.1:8790 after startup."],
    ["dist/plugins/packages/io.rabiroute.manager.wearable-companion/1.0.0/worker.ps1", "$managerUrl = 'http://127.0.0.1:8790'"],
    ["dist/plugins/packages/io.rabiroute.manager.wearable-companion/1.0.0/manager.mjs", "spawn('schtasks.exe', ['/Create']);"],
    ["dist/plugins/packages/io.rabiroute.manager.wearable-companion/1.0.0/start.ps1", "Start-Process schtasks.exe -ArgumentList '/Create'"],
    ["dist/plugins/packages/io.rabiroute.manager.wearable-companion/1.0.0/com.vbs", "CreateObject(\"Schedule.Service\")"],
    ["dist/plugins/packages/io.rabiroute.manager.wearable-companion/1.0.0/audit.ps1", "Get-ScheduledTask -TaskName RabiLinkWearableHealthCompanion"],
    ["plugin-adapters/foreign/start.ps1", "schtasks.exe /Query"],
  ]) {
    withPayload((root) => {
      const target = path.join(root, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      assert.throws(() => writeManifest(root, "0.2.1"), /retired Manager semantics/, relative);
      assert.equal(fs.existsSync(path.join(root, "release-manifest.json")), false);
    });
  }
});

test("release manifest scans UTF-16 operational scripts", () => {
  withPayload((root) => {
    const target = path.join(root, "scripts", "start-manager.ps1");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `\ufeff$managerUrl = 'http://127.0.0.1:8796'`, "utf16le");
    assert.throws(() => writeManifest(root, "0.2.1"), /retired Manager semantics/);
    assert.equal(fs.existsSync(path.join(root, "release-manifest.json")), false);
  });
});

test("release manifest ignores test fixtures but not operational package resources", () => {
  withPayload((root) => {
    const fixture = path.join(root, "scripts", "manager-contract.test.mjs");
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, "assert.match(text, /879[0-9]/);", "utf8");
    const packageResource = path.join(root, "dist", "plugins", "packages", "io.rabiroute.manager.fixture", "1.0.0", "worker.test.ps1");
    fs.mkdirSync(path.dirname(packageResource), { recursive: true });
    fs.writeFileSync(packageResource, "$managerPort = 8793", "utf8");
    assert.throws(() => writeManifest(root, "0.2.1"), /retired Manager semantics/);
    fs.rmSync(packageResource);
    assert.ok(writeManifest(root, "0.2.1").releaseId);
  });
});

test("release manifest permits explicit adapter ingress ports outside Manager truth", () => {
  withPayload((root) => {
    for (const relative of [
      "scripts/adapter-example.js",
      "dist/plugins/packages/io.rabiroute.adapter.fixture/1.0.0/worker.js",
      "dist/plugins/packages/io.rabiroute.manager.remote-agent/1.0.0/manager.mjs"
    ]) {
      const target = path.join(root, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = relative.includes("remote-agent")
        ? "const discoveryPort = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT ?? '8798');"
        : "const gatewayPort = 8790;";
      fs.writeFileSync(target, content, "utf8");
    }
    assert.ok(writeManifest(root, "0.2.1").releaseId);
  });

  withPayload((root) => {
    const target = path.join(root, "docs", "development-hot-reload.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, [
      "- WebGUI uses Vite HMR at http://127.0.0.1:8793/.",
      "- Manager is excluded from the safe reload loop."
    ].join("\n"), "utf8");
    assert.ok(writeManifest(root, "0.2.1").releaseId);
  });

  withPayload((root) => {
    const target = path.join(root, "plugin-adapters", "xiaoai-rabiroute", "RUNBOOK.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, [
      "$managerBaseUrl = $hostStatus.managerBaseUrl",
      "$managerPort = ([uri]$managerBaseUrl).Port",
      "# Adapter examples use ports 8791 and 8798.",
      "Get-NetTCPConnection -LocalPort $managerPort,8791,8798"
    ].join("\n"), "utf8");
    assert.ok(writeManifest(root, "0.2.1").releaseId);
  });

  withPayload((root) => {
    const target = path.join(root, "dist", "plugins", "packages", "io.rabiroute.manager.remote-agent", "1.0.0", "manager.mjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "const managerPort = 8790;", "utf8");
    assert.throws(() => writeManifest(root, "0.2.1"), /retired Manager semantics \(fixed Manager port value\)/);
  });
});

test("release manifest allows installer-owned legacy task migration", () => {
  withPayload((root) => {
    const target = path.join(root, "scripts", "Migrate-LegacyWearableHealthTask.ps1");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "Unregister-ScheduledTask -TaskName RabiLinkWearableHealthCompanion", "utf8");
    assert.ok(writeManifest(root, "0.2.1").releaseId);
  });
});

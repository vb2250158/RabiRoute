import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginCatalog,
  type RabiPluginHost,
  type RabiPluginManifest
} from "./pluginCatalog.js";

const manifest: RabiPluginManifest = {
  id: "builtin:manager/performance",
  name: "Performance",
  version: "1.0.0",
  kind: "builtin",
  hosts: ["manager", "web"],
  capabilities: ["manager.http", "performance.read"]
};

test("Plugin Catalog records valid lifecycle transitions without exposing mutable state", () => {
  const catalog = new PluginCatalog();
  const declared = catalog.declare({
    instanceId: " manager:performance ",
    manifest,
    host: "manager"
  });
  assert.equal(declared.instanceId, "manager:performance");
  assert.equal(declared.pluginId, "builtin:manager/performance");
  assert.equal(declared.status, "inactive");

  catalog.activating(declared.instanceId);
  assert.equal(catalog.get(declared.instanceId)?.status, "activating");
  catalog.active(declared.instanceId, "2026-08-21T16:30:00.000Z");
  assert.equal(catalog.get(declared.instanceId)?.status, "active");
  catalog.inactive(declared.instanceId, "2026-08-21T16:31:00.000Z");

  const snapshot = catalog.snapshot();
  assert.equal(snapshot.plugins[0]?.status, "inactive");
  assert.equal(snapshot.plugins[0]?.startedAt, "2026-08-21T16:30:00.000Z");
  assert.equal(snapshot.plugins[0]?.stoppedAt, "2026-08-21T16:31:00.000Z");

  (declared.manifest.hosts as RabiPluginHost[]).splice(0);
  (snapshot.plugins[0]?.manifest.hosts as RabiPluginHost[]).splice(0);
  assert.deepEqual(catalog.get(declared.instanceId)?.manifest.hosts, ["manager", "web"]);
});

test("Plugin Catalog publishes only the manifest and record allowlists", () => {
  const catalog = new PluginCatalog();
  catalog.declare({
    instanceId: "manager:allowlist",
    manifest: {
      ...manifest,
      target: "https://example.com/plugin.js",
      endpoint: "/api/manager/shutdown",
      query: "/api/private",
      body: { command: "shutdown" },
      resourceRoot: "C:/private/plugin"
    } as unknown as RabiPluginManifest,
    host: "manager"
  });

  const record = catalog.snapshot().plugins[0] as unknown as Record<string, unknown>;
  const publishedManifest = record.manifest as Record<string, unknown>;
  assert.deepEqual(Object.keys(publishedManifest).sort(), [
    "capabilities",
    "hosts",
    "id",
    "kind",
    "name",
    "version"
  ]);
  for (const forbidden of ["target", "endpoint", "query", "body", "resourceRoot"]) {
    assert.equal(Object.hasOwn(publishedManifest, forbidden), false);
    assert.equal(Object.hasOwn(record, forbidden), false);
  }
});

test("Plugin Catalog rejects unsupported manifest kinds and hosts", () => {
  const catalog = new PluginCatalog();
  assert.throws(() => catalog.declare({
    instanceId: "manager:invalid-kind",
    manifest: { ...manifest, kind: "script" } as unknown as RabiPluginManifest,
    host: "manager"
  }), /kind is unsupported/);
  assert.throws(() => catalog.declare({
    instanceId: "manager:invalid-host",
    manifest: { ...manifest, hosts: ["browser"] } as unknown as RabiPluginManifest,
    host: "browser" as RabiPluginHost
  }), /host is unsupported/);
  assert.deepEqual(catalog.snapshot().plugins, []);
});

test("Plugin Catalog rejects invalid status transitions and allows a failed activation retry", () => {
  const catalog = new PluginCatalog();
  catalog.declare({ instanceId: "manager:performance", manifest, host: "manager" });

  assert.throws(
    () => catalog.active("manager:performance"),
    /inactive -> active/
  );
  assert.throws(
    () => catalog.failed("manager:performance", { code: "activation_failed", message: "failed" }),
    /inactive -> failed/
  );

  catalog.activating("manager:performance");
  catalog.failed(
    "manager:performance",
    { code: "activation_failed", message: "listener unavailable" },
    "2026-08-21T16:31:00.000Z"
  );
  assert.equal(catalog.get("manager:performance")?.status, "failed");

  catalog.activating("manager:performance");
  catalog.active("manager:performance", "2026-08-21T16:32:00.000Z");
  assert.equal(catalog.get("manager:performance")?.status, "active");
});

test("Plugin Catalog keeps instance identity separate from plugin identity", () => {
  const catalog = new PluginCatalog();
  const first = catalog.declare({
    instanceId: "manager:performance:primary",
    manifest,
    host: "manager"
  });
  const second = catalog.declare({
    instanceId: "manager:performance:secondary",
    manifest,
    host: "manager",
    scope: "secondary"
  });

  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.pluginId, second.pluginId);
  assert.equal(first.manifest.id, first.pluginId);
  assert.deepEqual(
    catalog.snapshot().plugins.map(item => [item.instanceId, item.pluginId]),
    [
      ["manager:performance:primary", "builtin:manager/performance"],
      ["manager:performance:secondary", "builtin:manager/performance"]
    ]
  );

  assert.equal(catalog.remove(first.instanceId), true);
  assert.equal(catalog.get(first.instanceId), undefined);
  assert.equal(catalog.get(second.instanceId)?.pluginId, manifest.id);
  assert.throws(
    () => catalog.declare({ instanceId: second.instanceId, manifest, host: "manager" }),
    /already declared/
  );
});

test("Plugin Catalog reports missing dependencies without entering activation", () => {
  const catalog = new PluginCatalog();
  catalog.declare({
    instanceId: "manager:missing",
    manifest,
    host: "manager",
    missingCapabilities: ["speech.runtime", "speech.runtime", " "]
  });

  const beforeRevision = catalog.snapshot().revision;
  assert.equal(catalog.get("manager:missing")?.status, "waiting_dependency");
  assert.deepEqual(catalog.get("manager:missing")?.missingCapabilities, ["speech.runtime"]);
  assert.throws(() => catalog.activating("manager:missing"), /waiting for dependencies/);
  catalog.inactive("manager:missing");
  assert.equal(catalog.snapshot().revision, beforeRevision);
  assert.equal(catalog.get("manager:missing")?.status, "waiting_dependency");
});

test("Plugin Catalog sanitizes failures before they enter a public snapshot", () => {
  const catalog = new PluginCatalog();
  catalog.declare({ instanceId: "manager:failed", manifest, host: "manager" });
  catalog.activating("manager:failed");
  catalog.failed("manager:failed", {
    code: "Activation Failed!",
    message: "C:\\private\\runtime /home/rabi/config token=super-secret password: hunter2 Authorization: Bearer abc.def.ghi"
  }, "2026-08-21T16:31:00.000Z");

  const failure = catalog.get("manager:failed");
  assert.equal(failure?.error?.code, "activation_failed");
  assert.equal(failure?.error?.message.includes("super-secret"), false);
  assert.equal(failure?.error?.message.includes("hunter2"), false);
  assert.equal(failure?.error?.message.includes("abc.def.ghi"), false);
  assert.equal(failure?.error?.message.includes("C:\\private"), false);
  assert.equal(failure?.error?.message.includes("/home/rabi"), false);
  assert.match(failure?.error?.message ?? "", /<redacted>/);
  assert.match(failure?.error?.message ?? "", /<path>/);
});

test("Plugin Catalog filters only by the instance runtime host", () => {
  const catalog = new PluginCatalog();
  catalog.declare({ instanceId: "manager:performance", manifest, host: "manager" });
  catalog.declare({
    instanceId: "worker:local",
    manifest: { ...manifest, id: "builtin:worker/local", name: "Worker", hosts: ["worker"] },
    host: "worker"
  });

  assert.deepEqual(catalog.snapshot("web").plugins.map(item => item.instanceId), []);
  assert.deepEqual(catalog.snapshot("manager").plugins.map(item => item.instanceId), ["manager:performance"]);
  assert.deepEqual(catalog.snapshot("worker").plugins.map(item => item.instanceId), ["worker:local"]);
  assert.throws(
    () => catalog.declare({ instanceId: "invalid", manifest, host: "desktop" }),
    /does not support host desktop/
  );
});

test("Plugin Catalog clears root-owned state", () => {
  const catalog = new PluginCatalog();
  catalog.declare({ instanceId: "manager:performance", manifest, host: "manager" });
  const revision = catalog.snapshot().revision;
  catalog.clear();
  assert.deepEqual(catalog.snapshot().plugins, []);
  assert.equal(catalog.snapshot().revision, revision + 1);
  catalog.clear();
  assert.equal(catalog.snapshot().revision, revision + 1);
});

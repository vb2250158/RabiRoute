import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";

test("Gateway endpoints come from independent selected packages with their own implementation build input", async () => {
  const profile = JSON.parse(await fs.readFile(path.resolve("plugins/profiles/desktop.json"), "utf8"));
  const hosts: string[] = [];
  for (const instance of profile.instances) {
    const directory = path.resolve("plugins/builtin", instance.package, instance.version);
    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(directory, "rabi.plugin.json"), "utf8")));
    if (!manifest.entries.gateway) continue;
    hosts.push(instance.package);
    assert.ok(manifest.entries.manager);
    assert.ok(manifest.entries.web);
    assert.ok(manifest.provides.some(capability => capability.startsWith("endpoint.")));
    const specification = JSON.parse(await fs.readFile(path.join(directory, "runtime.build.json"), "utf8"));
    assert.equal(typeof specification.source, "string");
    assert.equal(typeof specification.factory, "string");
    const gateway = await fs.readFile(path.join(directory, "gateway.mjs"), "utf8");
    assert.match(gateway, /createEndpoint\(host\)/);
    assert.match(gateway, /await host\.prepareModules\(hostModules\)/);
    assert.doesNotMatch(gateway, /host\.(?:create\w+Adapter|start\w+Adapter)/);
  }
  assert.ok(hosts.length > 1);
});

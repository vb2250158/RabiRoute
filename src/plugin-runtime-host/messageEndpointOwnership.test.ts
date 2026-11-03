import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginProfile } from "../plugin-kernel/profile.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { gatewayMessageAdapterTypes } from "../shared/gatewayConfigModel.js";
import { readInstalledGatewayEndpointTypes } from "./messageEndpointOwnership.js";

test("installed Gateway ownership survives disabled settings and one unrelated broken package", async () => {
  const profile = parsePluginProfile({schemaVersion: 2, readyRequires: [], instances: [
    {id: "custom", package: "org.example.channel", version: "1.0.0", enabled: false},
    {id: "manager-only", package: "org.example.manager", version: "1.0.0", enabled: false},
    {id: "broken", package: "org.example.broken", version: "1.0.0", enabled: false}
  ]});
  const read = async (id: string) => {
    if (id === "org.example.broken") throw new Error("This package's manifest is unavailable.");
    return parsePluginManifest({schemaVersion: 2, id, version: "1.0.0", entries: {manager: {execution: "in_process", module: "./manager.mjs"},
      ...(id === "org.example.channel" ? {gateway: {execution: "in_process", module: "./gateway.mjs"}} : {})},
      provides: [id === "org.example.channel" ? "endpoint.custom.channel@1" : "endpoint.custom.manager@1"], requires: [], optional: [], permissions: []});
  };
  const disabled = await readInstalledGatewayEndpointTypes(profile, read);
  assert.deepEqual([...disabled.types], ["custom.channel"]);
  assert.deepEqual(disabled.diagnostics.map(item => item.instanceId), ["broken"]);
  const enabled = await readInstalledGatewayEndpointTypes({...profile, instances: profile.instances.map(instance => ({...instance, enabled: true}))}, read);
  assert.deepEqual([...enabled.types], [...disabled.types]);
  assert.deepEqual(gatewayMessageAdapterTypes({id: "route", gatewayPort: 8790, messageAdapters: ["custom.channel", "custom.manager"]}, disabled.types), ["custom.channel"]);
});

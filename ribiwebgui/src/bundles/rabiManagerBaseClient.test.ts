/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Component } from "vue";
import type { TrustedWebPageRegistration } from "../pluginPages";
import type {
  TrustedWebSettingsRendererRegistration,
  TrustedWebStatusRendererRegistration
} from "../pluginRenderers";
import type { TrustedWebThemeResourceRegistration } from "../pluginThemes";
import { activate } from "./rabiManagerBaseClient";

type Registration = { kind: string; instanceId: string; routeId?: string; rendererId?: string; themeId?: string; dispose: () => void };
type InstanceApi = Readonly<{
  instanceId: string;
  pluginId: string;
  asComponent(value: Component): Component;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
}>;

function activateInstances(instanceIds: readonly string[]): Registration[] {
  const registrations: Registration[] = [];
  const apiByInstanceId = new Map<string, InstanceApi>();
  for (const instanceId of instanceIds) {
    const register = (kind: string, input: object) => {
      const record = input as Record<string, unknown>;
      const registration: Registration = { kind, instanceId, routeId: record.routeId as string | undefined, rendererId: record.rendererId as string | undefined, themeId: record.themeId as string | undefined, dispose: () => {} };
      registrations.push(registration);
      return () => { const index = registrations.indexOf(registration); if (index >= 0) registrations.splice(index, 1); };
    };
    apiByInstanceId.set(instanceId, {
      instanceId,
      pluginId: "rabi.manager.base",
      asComponent: value => value,
      registerPage: input => register("page", input),
      registerSettingsRenderer: input => register("settings", input),
      registerStatusRenderer: input => register("status", input),
      registerTheme: input => register("theme", input)
    });
  }
  const dispose = activate({
    instanceIds,
    forInstance: instanceId => {
      const api = apiByInstanceId.get(instanceId);
      if (!api) throw new Error(`Missing test instance: ${instanceId}`);
      return api;
    }
  });
  registrations.push({ kind: "bundle", instanceId: "bundle", dispose });
  return registrations;
}

test("one base Web Bundle activation registers every selected Manager instance contribution", () => {
  const registrations = activateInstances(["manager:core", "manager:persona", "manager:desktop"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:core" && item.kind === "page").map(item => item.routeId), ["route.overview", "global.settings", "global.docs"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:core" && item.kind === "theme").map(item => item.themeId), ["system", "light", "dark"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:persona" && item.kind === "page").map(item => item.routeId), ["route.persona", "route.persona-document", "route.knowledge", "route.persona-sync"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:desktop" && item.kind === "settings").map(item => item.rendererId), ["builtin.desktop-settings.v1"]);
  assert.equal(registrations.filter(item => item.kind === "bundle").length, 1);
});

test("built base client uses a revision-local graph for lazy chunks", () => {
  const webRoot = new URL("../../../plugins/packages/rabi.manager.base/0.2.1/web/", import.meta.url);
  const client = readFileSync(new URL("client.mjs", webRoot), "utf8");
  assert.match(client, /activate/);
  assert.match(client, /from"\.\/rabiManagerBaseClient-/);

  const implementationMatch = client.match(/from"\.\/(rabiManagerBaseClient-[^"]+\.js)"/);
  assert.ok(implementationMatch, "Base Bundle implementation import is missing.");
  const implementation = readFileSync(new URL(implementationMatch[1]!, webRoot), "utf8");
  assert.match(implementation, /RoleKnowledgePage-/);
  assert.match(implementation, /import\("\.\/RoleKnowledgePage-/);
  assert.match(implementation, /new URL\(e,r\)\.href/);
  assert.doesNotMatch(implementation, /return"\/"\+\w/);
});

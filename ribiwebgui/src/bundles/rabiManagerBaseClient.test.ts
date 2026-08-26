/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activate } from "./rabiManagerBaseClient";

type Registration = { kind: string; routeId?: string; rendererId?: string; themeId?: string; dispose: () => void };

function activateInstance(instanceId: string): Registration[] {
  const registrations: Registration[] = [];
  const register = (kind: string, input: Record<string, unknown>) => {
    const registration: Registration = { kind, routeId: input.routeId as string | undefined, rendererId: input.rendererId as string | undefined, themeId: input.themeId as string | undefined, dispose: () => {} };
    registrations.push(registration);
    return () => { const index = registrations.indexOf(registration); if (index >= 0) registrations.splice(index, 1); };
  };
  const dispose = activate({
    instanceId, pluginId: "rabi.manager.base", asComponent: value => value,
    registerPage: input => register("page", input),
    registerSettingsRenderer: input => register("settings", input),
    registerStatusRenderer: input => register("status", input),
    registerTheme: input => register("theme", input)
  });
  registrations.push({ kind: "bundle", dispose });
  return registrations;
}

test("base Bundle registers only the selected Manager instance contribution", () => {
  const core = activateInstance("manager:core");
  assert.deepEqual(core.filter(item => item.kind === "page").map(item => item.routeId), ["route.overview", "global.settings", "global.docs"]);
  assert.deepEqual(core.filter(item => item.kind === "theme").map(item => item.themeId), ["system", "light", "dark"]);
  const persona = activateInstance("manager:persona");
  assert.deepEqual(persona.filter(item => item.kind === "page").map(item => item.routeId), ["route.persona", "route.persona-document", "route.knowledge", "route.persona-sync"]);
  const desktop = activateInstance("manager:desktop");
  assert.deepEqual(desktop.filter(item => item.kind === "settings").map(item => item.rendererId), ["builtin.desktop-settings.v1"]);
});

test("built base client module is a real Bundle entry with its revision-local module tree", () => {
  const bundle = readFileSync(new URL("../../../plugins/packages/rabi.manager.base/0.2.1/web/client.mjs", import.meta.url), "utf8");
  assert.match(bundle, /activate/);
  assert.match(bundle, /RoleKnowledgePage-/);
  assert.match(bundle, /from"\.\/routeScopedNavigation-/);
  assert.match(bundle, /import\("\.\/RoleKnowledgePage-/);
});



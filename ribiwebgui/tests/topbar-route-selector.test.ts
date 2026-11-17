import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { showsRouteSwitcher } from "../src/routeScopedNavigation";
import { isRolePage, roleConfigPath } from "../src/roleScopedNavigation";

test("route selector appears only on adapters, persona and knowledge pages", () => {
  for (const route of ["/routes", "/routes/main", "/routes/main/adapters", "/persona", "/persona/main", "/routes/main/persona", "/routes/main/persona/document", "/knowledge", "/routes/main/knowledge"]) {
    assert.equal(showsRouteSwitcher(route), true, route);
  }
  for (const route of ["/overview", "/routes/main/overview", "/speech", "/routes/main/speech", "/runtime", "/routes/main/runtime", "/performance", "/settings", "/video", "/rabilink", "/lan-agents", "/docs", "/routes/main/unknown", "/routes/main/persona/sync"]) {
    assert.equal(showsRouteSwitcher(route), false, route);
  }
});

test("role pages have independent identities without a Route binding", () => {
  for (const pathname of ["/roles", "/roles/Example", "/roles/Example/document", "/roles/Example/knowledge"]) {
    assert.equal(isRolePage(pathname), true, pathname);
  }
  for (const pathname of ["/routes", "/routes/main/adapters", "/settings"]) {
    assert.equal(isRolePage(pathname), false, pathname);
  }
  assert.equal(roleConfigPath("Example role"), "/roles/Example%20role/config");
});

test("the sidebar owns the role switcher and the scoped Route selector", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const app = fs.readFileSync(path.join(root, "src/App.vue"), "utf8");
  const shell = fs.readFileSync(path.join(root, "src/shell.css"), "utf8");
  const sidebar = app.slice(app.indexOf("<v-navigation-drawer"), app.indexOf("</v-navigation-drawer>"));
  const topbar = app.slice(app.indexOf("<header v-if="), app.indexOf("</header>"));
  assert.doesNotMatch(app, /<v-app-bar\b/);
  assert.equal((app.match(/<v-select\b/g) || []).length, 1);
  assert.doesNotMatch(topbar, /<v-select|RoleSourcePicker/);
  assert.match(sidebar, /class="sidebar-context">\s*<RoleSourcePicker @select="selectRole" \/>/);
  assert.match(topbar, /class="page-bar-title">\{\{ pageTitle \}\}<\/h1>/);
  const picker = fs.readFileSync(path.join(root, "src/components/RoleSourcePicker.vue"), "utf8");
  assert.match(picker, /store\.selectedRoleId/);
  assert.match(picker, /:disabled="!!role\.error"/);
  assert.match(picker, /emit\("select", roleId, source\.value\)/);
  assert.match(sidebar, /<v-select[\s\S]*?v-if="showRouteSwitcher && !showRoleSwitcher"/);
  assert.match(app, /computed\(\(\) => showsRouteSwitcher\(route.path\)\)/);
  assert.match(sidebar, /:model-value="store.selectedGatewayId"/);
  assert.match(sidebar, /:items="routeOptions"/);
  assert.match(app, /const title = String\(gateway.routeName \|\| gateway.name \|\| gateway.id\)/);
  assert.match(sidebar, /@update:model-value="value => selectGateway\(String\(value \|\| ''\)\)"/);
  assert.match(shell, /\.sidebar-context \.context-route-picker\s*\{[^}]*width: 100%/);
  assert.doesNotMatch(shell, /(?:^|\n)\.route-picker\s*\{/);
});

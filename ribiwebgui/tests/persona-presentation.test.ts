import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayPersonaDisplayName,
  personaOptionDisplayName
} from "../src/personaPresentation";

test("uses the persona markdown title before internal identifiers", () => {
  assert.equal(personaOptionDisplayName({
    value: "XinghaiBuilder",
    label: "XinghaiBuilder",
    roleTitle: "星海建造师 策划 程序"
  }), "星海建造师 策划 程序");

  assert.equal(gatewayPersonaDisplayName({
    id: "XinghaiBuilder-main",
    configName: "XinghaiBuilder-main",
    routeName: "旧航线名称",
    agentRoleId: "XinghaiBuilder"
  }, {
    selectedRoleId: "XinghaiBuilder",
    selectedRoleTitle: "星海建造师 策划 程序",
    options: [{
      value: "XinghaiBuilder",
      label: "XinghaiBuilder",
      roleTitle: "星海建造师 策划 程序"
    }]
  }), "星海建造师 策划 程序");
});

test("falls back through route display name, role id, and config name", () => {
  assert.equal(gatewayPersonaDisplayName({
    id: "route-id",
    configName: "route-config",
    routeName: "Rabi",
    agentRoleId: "RabiRole"
  }), "Rabi");
  assert.equal(gatewayPersonaDisplayName({
    id: "route-id",
    configName: "route-config",
    agentRoleId: "RabiRole"
  }), "RabiRole");
  assert.equal(gatewayPersonaDisplayName({
    id: "route-id",
    configName: "route-config"
  }), "route-config");
});


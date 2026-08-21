import assert from "node:assert/strict";
import test from "node:test";
import { resolveInterfaceTheme } from "../src/interfaceTheme";

test("interface theme resolves explicit and system choices", () => {
  assert.equal(resolveInterfaceTheme("light", true), "light");
  assert.equal(resolveInterfaceTheme("dark", false), "dark");
  assert.equal(resolveInterfaceTheme("system", false), "light");
  assert.equal(resolveInterfaceTheme("system", true), "dark");
});

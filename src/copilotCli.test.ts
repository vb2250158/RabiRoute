import assert from "node:assert/strict";
import test from "node:test";
import { resolveCopilotSessionName } from "./copilotCli.js";

test("Copilot session names have a dedicated configuration source", () => {
  assert.equal(resolveCopilotSessionName(" Copilot Route ", "Configured Copilot"), "Copilot Route");
  assert.equal(resolveCopilotSessionName(undefined, " Configured Copilot "), "Configured Copilot");
  assert.equal(resolveCopilotSessionName(undefined, undefined), "");
});

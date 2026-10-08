import assert from "node:assert/strict";
import test from "node:test";
import { vacuumVideoPresentation } from "../src/vacuumVideoPresentation.js";
import type { VacuumVideoSession } from "../src/homeDeviceClient.js";

const idle = { starting: false, stopping: false, passwordSaved: true, editingPassword: false, rendered: false };
function session(state: VacuumVideoSession["state"]): VacuumVideoSession { return { sessionId: "fixture-session", state, audio: false }; }
test("saved credentials reuse a compact entry; first use and explicit editing reveal the form", () => {
 assert.equal(vacuumVideoPresentation(idle).passwordEntry, false);
 assert.equal(vacuumVideoPresentation({ ...idle, passwordSaved: false }).passwordEntry, true);
 assert.equal(vacuumVideoPresentation({ ...idle, editingPassword: true }).passwordEntry, true);
});
test("pending start hides all password management before a session receipt exists", () => {
 const view = vacuumVideoPresentation({ ...idle, starting: true, editingPassword: true });
 assert.equal(view.phase, "starting"); assert.equal(view.passwordManagement, false); assert.equal(view.passwordEntry, false);
});
for (const state of ["connecting", "streaming", "failed"] as const) test(`${state} session requires exit before credentials can be managed`, () => {
 const view = vacuumVideoPresentation({ ...idle, session: session(state), editingPassword: true });
 assert.equal(view.sessionOpen, true); assert.equal(view.passwordManagement, false); assert.equal(view.passwordEntry, false);
});
test("exit in flight keeps credentials hidden even after a terminal status read", () => {
 const view = vacuumVideoPresentation({ ...idle, session: session("stopped"), stopping: true, editingPassword: true });
 assert.equal(view.phase, "stopping"); assert.equal(view.passwordManagement, false);
});
test("confirmed exit restores compact management without showing the PIN", () => {
 const view = vacuumVideoPresentation({ ...idle, session: session("stopped") });
 assert.equal(view.passwordManagement, true); assert.equal(view.passwordEntry, false); assert.equal(view.sessionOpen, false);
});
test("only rendered video claims playback, not an accepted streaming receipt", () => {
 assert.equal(vacuumVideoPresentation({ ...idle, session: session("streaming") }).label, "正在加载画面");
 assert.equal(vacuumVideoPresentation({ ...idle, session: session("streaming"), rendered: true }).label, "实时画面");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkInstalledDataCompatibility } from "./check-installed-data-compatibility.mjs";

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-data-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate"); const state = path.join(root, "state");
  fs.mkdirSync(path.join(candidate, "dist/manager"), { recursive: true });
  fs.mkdirSync(path.join(state, "data/.runtime"), { recursive: true });
  fs.writeFileSync(path.join(candidate, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(candidate, "dist/manager/lanAgentAuthority.js"), source);
  const file = path.join(state, "data/.runtime/lan-agent-authority.json");
  fs.writeFileSync(file, '{"schemaVersion":2,"nodes":[]}\n');
  return { candidate, state, file };
}

test("installed data preflight delegates to the candidate's read-only owner and retains actual bytes", async t => {
  const f = fixture(t, 'import fs from "node:fs"; export function inspectLanAgentCredentialState(p) { const s=JSON.parse(fs.readFileSync(p,"utf8")); return {schemaVersion:s.schemaVersion,nodeCount:s.nodes.length}; }');
  const before = fs.readFileSync(f.file);
  const result = await checkInstalledDataCompatibility(f.candidate, f.state);
  assert.equal(result.ready, true); assert.equal(result.schemaVersion, 2); assert.equal(result.nodeCount, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("missing or rejecting owner contracts fail before any activation", async t => {
  for (const source of ['export const unrelated = true;', 'export function inspectLanAgentCredentialState() { throw new Error("fixture incompatible schema"); }']) {
    const f = fixture(t, source); const before = fs.readFileSync(f.file);
    await assert.rejects(checkInstalledDataCompatibility(f.candidate, f.state), /read-only computer credential|incompatible schema/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
});

test("a concurrent credential publication stops admission without overwriting its new bytes", async t => {
  const f = fixture(t, 'import fs from "node:fs"; export function inspectLanAgentCredentialState(p) { fs.appendFileSync(p," "); return {schemaVersion:2,nodeCount:0}; }');
  await assert.rejects(checkInstalledDataCompatibility(f.candidate, f.state), /changed during preflight/);
  assert.equal(fs.readFileSync(f.file, "utf8").endsWith(" "), true);
});

test("fresh installations need no credential store and relative roots are rejected", async t => {
  const f = fixture(t, 'export const unrelated = true;'); fs.unlinkSync(f.file);
  assert.deepEqual(await checkInstalledDataCompatibility(f.candidate, f.state), { ready: true, credentialStorePresent: false });
  await assert.rejects(checkInstalledDataCompatibility("relative", f.state), /absolute/);
});

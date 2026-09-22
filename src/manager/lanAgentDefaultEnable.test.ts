import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lan-default-enable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "authority.json");
  const authority = new LanAgentAuthority({ statePath });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-a");
  return { authority, credential, statePath };
}
const agent = { agentId: "agent-a", provider: "dsh", sessionId: "session-a", managedSessionIds: ["child-a"] };

test("authenticated catalog registers exact identities and defaults to enabled without an approval command", t => {
  const { authority, credential, statePath } = fixture(t);
  assert.equal(authority.authorize(credential.token, agent.agentId), null);
  assert.throws(() => authority.registerAgentCatalog("invalid", [agent]), /credential/);
  authority.registerAgentCatalog(credential.token, [agent]);
  assert.deepEqual(authority.authorize(credential.token, agent.agentId), { nodeId: "node-a" });
  assert.deepEqual(authority.getApprovedAgentBinding("node-a", agent.agentId), agent);
  assert.equal(authority.authorize(credential.token, "unregistered"), null);
  assert.equal(authority.isAgentEnabled("unknown-node", agent.agentId), false);
  assert.deepEqual(authority.getSnapshot().nodes[0].enabledAgentIds, [agent.agentId]);
  const revision = authority.getSnapshot().revision;
  authority.registerAgentCatalog(credential.token, [agent]);
  assert.equal(authority.getSnapshot().revision, revision);
  const restarted = new LanAgentAuthority({ statePath });
  assert.ok(restarted.authorize(credential.token, agent.agentId));
  assert.deepEqual(restarted.getApprovedAgentBinding("node-a", agent.agentId), agent);
});

test("explicit disable survives restart, catalog changes, removal and reappearance", t => {
  const { authority, credential, statePath } = fixture(t);
  authority.registerAgentCatalog(credential.token, [agent]);
  authority.setAgentEnabled("node-a", agent.agentId, false);
  const restarted = new LanAgentAuthority({ statePath });
  restarted.registerAgentCatalog(credential.token, []);
  restarted.registerAgentCatalog(credential.token, [{ ...agent, sessionId: "session-b", managedSessionIds: [] }]);
  assert.equal(restarted.authorize(credential.token, agent.agentId), null);
  assert.deepEqual(restarted.getSnapshot().nodes[0].enabledAgentIds, []);
  assert.deepEqual(restarted.getApprovedAgentBinding("node-a", agent.agentId)?.managedSessionIds, []);
  restarted.setAgentEnabled("node-a", agent.agentId, true);
  assert.ok(restarted.authorize(credential.token, agent.agentId));
  restarted.registerAgentCatalog(credential.token, []);
  assert.equal(restarted.authorize(credential.token, agent.agentId), null);
  assert.equal(restarted.getApprovedAgentBinding("node-a", agent.agentId), null);
});

test("explicit disable before first registration is durable and cannot be erased by catalog", t => {
  const { authority, credential } = fixture(t);
  authority.setAgentEnabled("node-a", agent.agentId, false);
  authority.registerAgentCatalog(credential.token, [agent]);
  assert.equal(authority.authorize(credential.token, agent.agentId), null);
});

test("legacy migration retains bound disabled IDs and enables only authenticated newly registered IDs", t => {
  const { authority, credential, statePath } = fixture(t);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  delete state.nodes[0].disabledAgentIds;
  state.nodes[0].agentBindings = [agent];
  fs.writeFileSync(statePath, JSON.stringify(state));
  const before = fs.readFileSync(statePath, "utf8");
  const restarted = new LanAgentAuthority({ statePath });
  assert.equal(fs.readFileSync(statePath, "utf8"), before); // Reads never migrate the file.
  const fresh = { ...agent, agentId: "fresh-agent" };
  restarted.registerAgentCatalog(credential.token, [agent, fresh]);
  assert.equal(authority.authorize(credential.token, agent.agentId), null);
  assert.ok(authority.authorize(credential.token, fresh.agentId));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[0].disabledAgentIds, [agent.agentId]);
});

test("catalog failure is atomic, revoked and cross-node credentials cannot claim another node", t => {
  const { authority, credential, statePath } = fixture(t);
  authority.registerAgentCatalog(credential.token, [agent]);
  const other = authority.enroll(authority.issueBootstrapTicket().ticket, "node-b");
  authority.registerAgentCatalog(other.token, [{ ...agent, sessionId: "other-session" }]);
  assert.equal(authority.getApprovedAgentBinding("node-a", agent.agentId)?.sessionId, agent.sessionId);
  assert.throws(() => authority.registerAgentCatalog(credential.token, [agent, agent]), /Duplicate/);
  const before = fs.readFileSync(statePath, "utf8");
  const mock = t.mock.method(fs, "renameSync", () => { throw new Error("fixture catalog write failure"); });
  assert.throws(() => authority.registerAgentCatalog(credential.token, []), /write failure/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  mock.mock.restore();
  authority.revokeNode("node-a");
  assert.throws(() => authority.registerAgentCatalog(credential.token, [agent]), /credential/);
  assert.equal(authority.getApprovedAgentBinding("node-a", agent.agentId), null);
});

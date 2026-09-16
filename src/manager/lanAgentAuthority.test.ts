import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LanAgentAuthority, isLanAgentCredentialToken } from "./lanAgentAuthority.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-authority-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "authority.json");
  return { dir, statePath, authority: new LanAgentAuthority({ statePath }) };
}

function enroll(authority: LanAgentAuthority, nodeId = "node-a") {
  return authority.enroll(authority.issueBootstrapTicket().ticket, nodeId);
}

test("credentials persist across restart; bootstrap tickets do not; agent grants default deny", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const pending = authority.issueBootstrapTicket();
  assert.deepEqual(authority.authenticate(credential.token), { nodeId: "node-a" });
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  authority.setAgentEnabled("node-a", "agent-a", true);
  const restarted = new LanAgentAuthority({ statePath });
  assert.deepEqual(restarted.authorize(credential.token, "agent-a"), { nodeId: "node-a" });
  assert.equal(restarted.authorize(credential.token, "agent-b"), null);
  assert.equal(restarted.validateBootstrapTicket(pending.ticket), false);
  const persisted = fs.readFileSync(statePath, "utf8");
  assert.ok(!persisted.includes(credential.token));
  assert.ok(!persisted.includes(credential.token.split(":")[2]));
  assert.ok(!persisted.includes(pending.ticket));
  assert.match(JSON.parse(persisted).nodes[0].secretHash, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
});

test("download validation is repeatable; enrollment consumes ticket exactly once", t => {
  const { authority } = fixture(t);
  const { ticket } = authority.issueBootstrapTicket();
  assert.equal(authority.validateBootstrapTicket(ticket), true);
  assert.equal(authority.validateBootstrapTicket(ticket), true);
  authority.enroll(ticket, "node-a");
  assert.equal(authority.validateBootstrapTicket(ticket), false);
  assert.throws(() => authority.enroll(ticket, "node-b"), /Invalid or expired/);
});

test("default tickets last thirty minutes and a successful exchange immediately invalidates them", t => {
  const { statePath } = fixture(t);
  let now = 1_000;
  const authority = new LanAgentAuthority({ statePath, now: () => now });
  const ticket = authority.issueBootstrapTicket();
  assert.equal(ticket.expiresAt - now, 30 * 60_000);
  now = ticket.expiresAt - 1;
  assert.equal(authority.validateBootstrapTicket(ticket.ticket), true);
  const credential = authority.enroll(ticket.ticket, "node-a");
  assert.equal(authority.validateBootstrapTicket(ticket.ticket), false);
  assert.throws(() => authority.enroll(ticket.ticket, "node-b"), /Invalid or expired/);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  const expiring = authority.issueBootstrapTicket();
  now = expiring.expiresAt;
  assert.equal(authority.validateBootstrapTicket(expiring.ticket), false);
  assert.throws(() => authority.enroll(expiring.ticket, "node-b"), /Invalid or expired/);
  assert.throws(() => new LanAgentAuthority({ statePath, bootstrapTtlMs: 30 * 60_000 + 1 }), /Invalid LAN agent bootstrap limits/);
});

test("tickets are bounded and expire at the deadline; expired capacity is reclaimed", t => {
  const { statePath } = fixture(t);
  let now = 1_000;
  const authority = new LanAgentAuthority({ statePath, now: () => now, bootstrapTtlMs: 50, maxBootstrapTickets: 2 });
  const first = authority.issueBootstrapTicket();
  assert.equal(first.expiresAt, 1_050);
  authority.issueBootstrapTicket();
  assert.throws(() => authority.issueBootstrapTicket(), /capacity/);
  now = 1_049;
  assert.equal(authority.validateBootstrapTicket(first.ticket), true);
  now = 1_050;
  assert.equal(authority.validateBootstrapTicket(first.ticket), false);
  assert.throws(() => authority.enroll(first.ticket, "node-a"), /expired/);
  assert.equal(authority.validateBootstrapTicket(authority.issueBootstrapTicket().ticket), true);
});

test("duplicate node cannot be replaced by a fresh ticket, including after restart", t => {
  const { authority, statePath } = fixture(t);
  const original = enroll(authority);
  authority.setAgentEnabled("node-a", "agent-a", true);
  const restarted = new LanAgentAuthority({ statePath });
  const { ticket } = restarted.issueBootstrapTicket();
  const before = fs.readFileSync(statePath, "utf8");
  assert.throws(() => restarted.enroll(ticket, "node-a"), /already enrolled/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.deepEqual(restarted.authorize(original.token, "agent-a"), { nodeId: "node-a" });
  assert.equal(restarted.validateBootstrapTicket(ticket), true);
  assert.equal(restarted.enroll(ticket, "node-b").nodeId, "node-b");
});

test("malformed, wrong-secret and cross-node credentials never authenticate", t => {
  const { authority } = fixture(t);
  const a = enroll(authority, "node-a");
  const b = enroll(authority, "node-b");
  authority.setAgentEnabled("node-a", "agent-a", true);
  const wrongSecret = `${a.token.slice(0, -1)}${a.token.endsWith("A") ? "B" : "A"}`;
  for (const token of ["", "Bearer " + a.token, `${a.token}:extra`, wrongSecret,
    a.token.replace("node-a", "node-b"), a.token.replace("lan1:", "lan2:"), "x".repeat(100_000)]) {
    assert.equal(authority.authenticate(token), null);
    assert.equal(authority.authorize(token, "agent-a"), null);
  }
  assert.equal(authority.authorize(b.token, "agent-a"), null);
  assert.equal(authority.authorize(a.token, "../agent-a"), null);
});

test("offline grant revocation and node revocation take effect across existing instances", t => {
  const { authority, statePath } = fixture(t);
  const a = enroll(authority);
  const other = new LanAgentAuthority({ statePath });
  authority.setAgentEnabled("node-a", "agent-a", true);
  assert.ok(other.authorize(a.token, "agent-a"));
  other.setAgentEnabled("node-a", "agent-a", false);
  assert.equal(authority.authorize(a.token, "agent-a"), null);
  assert.ok(authority.authenticate(a.token));
  authority.setAgentEnabled("node-a", "agent-a", true);
  other.revokeNode("node-a");
  assert.equal(authority.authenticate(a.token), null);
  assert.equal(authority.authorize(a.token, "agent-a"), null);
  assert.throws(() => authority.setAgentEnabled("node-a", "agent-a", true), /not enrolled/);
  assert.doesNotThrow(() => other.revokeNode("node-a"));
  const replacement = enroll(authority);
  assert.notEqual(a.token, replacement.token);
  assert.equal(authority.authenticate(a.token), null);
  assert.equal(authority.authorize(replacement.token, "agent-a"), null);
});

test("independent owners reload before writes and never clobber another node grant", t => {
  const { authority, statePath } = fixture(t);
  const other = new LanAgentAuthority({ statePath });
  const a = enroll(authority, "node-a");
  const b = enroll(other, "node-b");
  authority.setAgentEnabled("node-a", "agent-a", true);
  other.setAgentEnabled("node-b", "agent-b", true);
  assert.ok(other.authorize(a.token, "agent-a"));
  assert.ok(authority.authorize(b.token, "agent-b"));
});

test("failed enrollment write neither creates identity nor consumes ticket", t => {
  const { authority, statePath } = fixture(t);
  const { ticket } = authority.issueBootstrapTicket();
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === statePath) throw Object.assign(new Error("simulated write failure"), { code: "EIO" });
    original(source, destination);
  });
  assert.throws(() => authority.enroll(ticket, "node-a"), /simulated write failure/);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(authority.validateBootstrapTicket(ticket), true);
  assert.deepEqual(fs.readdirSync(path.dirname(statePath)), []);
  mock.mock.restore();
  assert.ok(authority.authenticate(authority.enroll(ticket, "node-a").token));
});

test("failed grant and revocation writes preserve both file and effective policy", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const original = fs.renameSync;
  let fail = true;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (fail && String(destination) === statePath) throw Object.assign(new Error("simulated write failure"), { code: "EIO" });
    original(source, destination);
  });
  const before = fs.readFileSync(statePath, "utf8");
  assert.throws(() => authority.setAgentEnabled("node-a", "agent-a", true), /write failure/);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  fail = false;
  authority.setAgentEnabled("node-a", "agent-a", true);
  const enabled = fs.readFileSync(statePath, "utf8");
  fail = true;
  assert.throws(() => authority.setAgentEnabled("node-a", "agent-a", false), /write failure/);
  assert.throws(() => authority.revokeNode("node-a"), /write failure/);
  assert.ok(authority.authorize(credential.token, "agent-a"));
  assert.equal(fs.readFileSync(statePath, "utf8"), enabled);
  assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ["authority.json"]);
});

test("corrupt, duplicate, unknown-version and unsafe state fail closed without overwrite", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const valid = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const text of ["{broken", JSON.stringify({ schemaVersion: 2, nodes: [] }),
    JSON.stringify({ schemaVersion: 1, nodes: [valid.nodes[0], valid.nodes[0]] }),
    JSON.stringify({ schemaVersion: 1, nodes: [{ ...valid.nodes[0], enabledAgentIds: ["agent-a", "agent-a"] }] }),
    JSON.stringify({ schemaVersion: 1, nodes: [{ ...valid.nodes[0], enabledAgentIds: [true] }] }),
    JSON.stringify({ ...valid, token: "unexpected-secret-field" })]) {
    fs.writeFileSync(statePath, text);
    assert.throws(() => new LanAgentAuthority({ statePath }), /Invalid LAN agent authority/);
    assert.throws(() => authority.authenticate(credential.token), /Invalid LAN agent authority/);
    assert.throws(() => authority.revokeNode("node-a"), /Invalid LAN agent authority/);
    assert.equal(fs.readFileSync(statePath, "utf8"), text);
  }
});

test("audit covers committed, rejected and failed operations without credential or hash disclosure", t => {
  const { authority, statePath } = fixture(t);
  const records: RecordedDataMutationAudit[] = [];
  const detach = installDataMutationAuditSink(record => records.push(record));
  t.after(detach);
  const { ticket } = authority.issueBootstrapTicket();
  const credential = authority.enroll(ticket, "node-a");
  const secretHash = JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[0].secretHash;
  authority.setAgentEnabled("node-a", "agent-a", true);
  authority.setAgentEnabled("node-a", "agent-a", false);
  assert.throws(() => authority.enroll(ticket, "node-b"));
  fs.writeFileSync(statePath, `{${credential.token}`);
  assert.throws(() => authority.revokeNode("node-a"));
  const serialized = JSON.stringify(records);
  for (const secret of [ticket, credential.token, credential.token.split(":")[2], secretHash]) {
    assert.ok(!serialized.includes(secret));
  }
  for (const outcome of ["started", "committed", "rejected", "failed"]) {
    assert.ok(records.some(record => record.owner === "lan-agent-authority" && record.outcome === outcome));
  }
});

test("secret-free snapshots are detached; grant CAS rejects stale UI and no-ops preserve revision", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const snapshot = authority.getSnapshot();
  assert.deepEqual(authority.getSnapshot().nodes, [{ nodeId: "node-a", enabledAgentIds: [] }]);
  assert.equal(isLanAgentCredentialToken(credential.token), true);
  assert.equal(isLanAgentCredentialToken("lan1:malformed"), true);
  assert.equal(isLanAgentCredentialToken("other-token"), false);
  snapshot.nodes[0].enabledAgentIds.push("agent-a");
  assert.equal(authority.isAgentEnabled("node-a", "agent-a"), false);
  authority.setAgentEnabled("node-a", "agent-a", true, snapshot.revision);
  assert.equal(authority.isAgentEnabled("node-a", "agent-a"), true);
  const current = authority.getSnapshot();
  assert.notEqual(current.revision, snapshot.revision);
  const other = new LanAgentAuthority({ statePath });
  assert.throws(() => other.setAgentEnabled("node-a", "agent-a", false, snapshot.revision), /revision conflict/);
  assert.equal(authority.isAgentEnabled("node-a", "agent-a"), true);
  authority.setAgentEnabled("node-a", "agent-a", true, current.revision);
  assert.equal(authority.getSnapshot().revision, current.revision);
  assert.equal(authority.isAgentEnabled("unknown", "agent-a"), false);
});

test("approved session bindings are admin-owned detached snapshots persisted across restart", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  assert.equal(authority.getApprovedAgentBinding("node-a", "agent-a"), null);
  const before = authority.getSnapshot().revision;
  const agent = { agentId: "agent-a", provider: "dsh", sessionId: "session-a", managedSessionIds: ["child-a"] };
  authority.approveAgentBinding("node-a", agent, before);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  const revision = authority.getSnapshot().revision;
  assert.notEqual(revision, before);
  agent.sessionId = "forged-session";
  agent.managedSessionIds.push("forged-child");
  const restarted = new LanAgentAuthority({ statePath });
  const approved = restarted.getApprovedAgentBinding("node-a", "agent-a");
  assert.equal(approved?.sessionId, "session-a");
  assert.deepEqual(approved?.managedSessionIds, ["child-a"]);
  approved!.managedSessionIds!.push("injected-child");
  authority.getSnapshot().nodes[0].agentBindings![0].sessionId = "injected-session";
  assert.equal(authority.getApprovedAgentBinding("node-a", "agent-a")?.sessionId, "session-a");
  assert.deepEqual(authority.getApprovedAgentBinding("node-a", "agent-a")?.managedSessionIds, ["child-a"]);
  assert.throws(() => authority.approveAgentBinding("node-a", agent, before), /revision conflict/);
  authority.approveAgentBinding("node-a", restarted.getApprovedAgentBinding("node-a", "agent-a")!, revision);
  assert.equal(authority.getSnapshot().revision, revision);
  authority.setAgentEnabled("node-a", "agent-a", true, revision);
  assert.ok(authority.authorize(credential.token, "agent-a"));
  authority.revokeNode("node-a");
  assert.equal(restarted.getApprovedAgentBinding("node-a", "agent-a"), null);
});

test("binding writes roll back atomically and audit never includes session claims", t => {
  const { authority, statePath } = fixture(t);
  enroll(authority);
  const agent = { agentId: "agent-a", provider: "dsh", sessionId: "private-session-claim" };
  const records: RecordedDataMutationAudit[] = [];
  const detach = installDataMutationAuditSink(record => records.push(record));
  t.after(detach);
  authority.approveAgentBinding("node-a", agent);
  const before = fs.readFileSync(statePath, "utf8");
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("simulated binding write failure"), { code: "EIO" }); });
  assert.throws(() => authority.approveAgentBinding("node-a", { ...agent, sessionId: "replacement" }), /write failure/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.equal(authority.getApprovedAgentBinding("node-a", "agent-a")?.sessionId, agent.sessionId);
  assert.ok(records.some(record => record.action === "approve-agent-binding" && record.outcome === "committed"));
  assert.ok(records.some(record => record.action === "approve-agent-binding" && record.outcome === "failed"));
  assert.ok(!JSON.stringify(records).includes(agent.sessionId));
});

test("invalid and duplicate persisted bindings fail closed; approval validates limits", t => {
  const { authority, statePath } = fixture(t);
  enroll(authority);
  const agent = { agentId: "agent-a", provider: "dsh", sessionId: "session-a" };
  for (const invalid of [{ ...agent, provider: "" }, { ...agent, sessionId: "bad\nclaim" },
    { ...agent, managedSessionIds: ["same", "same"] }, { ...agent, managedSessionIds: ["x".repeat(193)] }]) {
    assert.throws(() => authority.approveAgentBinding("node-a", invalid), /Invalid LAN agent authority binding/);
  }
  assert.throws(() => authority.approveAgentBinding("unknown", agent), /not enrolled/);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const bindings of [[agent, agent], [{ ...agent, extra: true }], [{ ...agent, managedSessionIds: "wrong" }], null]) {
    fs.writeFileSync(statePath, JSON.stringify({ ...state, nodes: [{ ...state.nodes[0], agentBindings: bindings }] }));
    assert.throws(() => new LanAgentAuthority({ statePath }), /Invalid LAN agent authority/);
  }
});

test("atomic approval enables once and fully replaces old managed identity claims", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const agent = { agentId: "agent-a", provider: "dsh", sessionId: "session-a", managedSessionIds: ["old-child"] };
  const initial = authority.getSnapshot().revision;
  const records: RecordedDataMutationAudit[] = [];
  t.after(installDataMutationAuditSink(record => records.push(record)));
  authority.approveAndEnableAgent("node-a", agent, initial);
  assert.ok(authority.authorize(credential.token, "agent-a"));
  assert.equal(records.filter(record => record.owner === "file-persistence" && record.outcome === "committed").length, 1);
  const revision = authority.getSnapshot().revision;
  authority.approveAndEnableAgent("node-a", agent, revision);
  assert.equal(authority.getSnapshot().revision, revision);
  assert.throws(() => authority.approveAndEnableAgent("node-a", agent, initial), /revision conflict/);
  assert.throws(() => authority.approveAndEnableAgent("node-a", agent, ""), /Invalid agent approval/);
  const replacement = { agentId: "agent-a", provider: "dsh", sessionId: "session-b" };
  authority.approveAndEnableAgent("node-a", replacement, revision);
  const restarted = new LanAgentAuthority({ statePath });
  assert.deepEqual(restarted.getApprovedAgentBinding("node-a", "agent-a"), replacement);
  assert.ok(restarted.authorize(credential.token, "agent-a"));
});

test("atomic approval write failure leaves neither partial binding nor partial enable", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const agent = { agentId: "agent-a", provider: "dsh", sessionId: "session-a" };
  const initial = authority.getSnapshot().revision;
  const before = fs.readFileSync(statePath, "utf8");
  const original = fs.renameSync;
  let fail = true;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (fail) throw Object.assign(new Error("simulated atomic approval failure"), { code: "EIO" });
    original(source, destination);
  });
  assert.throws(() => authority.approveAndEnableAgent("node-a", agent, initial), /atomic approval failure/);
  assert.equal(authority.getApprovedAgentBinding("node-a", "agent-a"), null);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  fail = false;
  authority.approveAndEnableAgent("node-a", agent, initial);
  authority.setAgentEnabled("node-a", "agent-a", false);
  const revision = authority.getSnapshot().revision;
  const disabled = fs.readFileSync(statePath, "utf8");
  fail = true;
  assert.throws(() => authority.approveAndEnableAgent("node-a", { ...agent, sessionId: "replacement" }, revision), /atomic approval failure/);
  assert.deepEqual(authority.getApprovedAgentBinding("node-a", "agent-a"), agent);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  assert.equal(fs.readFileSync(statePath, "utf8"), disabled);
});

test("durable authorization replay precedes CAS and live catalog checks across restart", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  let checks = 0;
  const input = { nodeId: "node-a", agentId: "agent-a", enabled: true,
    binding: { agentId: "agent-a", provider: "dsh", sessionId: "session-a" },
    expectedRevision: authority.getSnapshot().revision, idempotencyKey: "test-only-grant-1",
    validateBinding: () => { checks++; } };
  const first = authority.mutateAgentAuthorization(input);
  assert.equal(first.replayed, false);
  assert.equal(first.revision, authority.getSnapshot().revision);
  assert.equal(checks, 1);
  authority.setAgentEnabled("node-a", "agent-a", false);
  const current = authority.getSnapshot().revision;
  const restarted = new LanAgentAuthority({ statePath });
  const replay = restarted.mutateAgentAuthorization({ ...input, validateBinding: () => { throw new Error("catalog changed"); } });
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(replay.enabled, true); // Historical result does not re-enable current policy.
  assert.equal(restarted.authorize(credential.token, "agent-a"), null);
  assert.equal(restarted.getSnapshot().revision, current);
  assert.throws(() => restarted.mutateAgentAuthorization({ ...input, expectedRevision: current }), /idempotency conflict/);
  assert.throws(() => restarted.mutateAgentAuthorization({ ...input, binding: { ...input.binding, sessionId: "different" } }), /idempotency conflict/);
  assert.ok(!fs.readFileSync(statePath, "utf8").includes(input.idempotencyKey));
});

test("durable receipt and policy commit together; validator or write failure permits exact retry", t => {
  const { authority, statePath } = fixture(t);
  const credential = enroll(authority);
  const input = { nodeId: "node-a", agentId: "agent-a", enabled: true,
    binding: { agentId: "agent-a", provider: "dsh", sessionId: "session-a" },
    expectedRevision: authority.getSnapshot().revision, idempotencyKey: "test-only-grant-fail" };
  const before = fs.readFileSync(statePath, "utf8");
  assert.throws(() => authority.mutateAgentAuthorization({ ...input, validateBinding: () => { throw new Error("catalog rejected"); } }), /catalog rejected/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  const mock = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("receipt write failed"), { code: "EIO" }); });
  assert.throws(() => authority.mutateAgentAuthorization(input), /receipt write failed/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
  mock.mock.restore();
  assert.equal(authority.mutateAgentAuthorization(input).replayed, false);
  assert.equal(authority.mutateAgentAuthorization(input).replayed, true);
  assert.ok(authority.authorize(credential.token, "agent-a"));
});

test("receipt lifecycle bounds active entries and expires after 24h without changing policy revision", t => {
  const { statePath } = fixture(t);
  let now = 1_000;
  const authority = new LanAgentAuthority({ statePath, now: () => now });
  enroll(authority);
  const input = { nodeId: "node-a", agentId: "agent-a", enabled: false,
    expectedRevision: authority.getSnapshot().revision, idempotencyKey: "test-only-receipt-ttl" };
  authority.mutateAgentAuthorization(input);
  assert.equal(authority.getSnapshot().revision, input.expectedRevision);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const receipt = state.mutationReceipts[0];
  state.mutationReceipts = Array.from({ length: 1_000 }, (_, index) => ({ ...receipt,
    keyHash: index.toString(16).padStart(64, "0") }));
  fs.writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => authority.mutateAgentAuthorization(input), /capacity/);
  assert.equal(authority.getSnapshot().revision, input.expectedRevision);
  now += 24 * 60 * 60_000;
  assert.equal(authority.mutateAgentAuthorization(input).replayed, false);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).mutationReceipts.length, 1);
  assert.equal(authority.getSnapshot().revision, input.expectedRevision);
});

test("malformed or duplicate durable receipts fail closed", t => {
  const { authority, statePath } = fixture(t);
  enroll(authority);
  authority.mutateAgentAuthorization({ nodeId: "node-a", agentId: "agent-a", enabled: false,
    expectedRevision: authority.getSnapshot().revision, idempotencyKey: "test-only-receipt" });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const receipt = state.mutationReceipts[0];
  for (const mutationReceipts of [[receipt, receipt], [{ ...receipt, enabled: "true" }],
    [{ ...receipt, expiresAt: receipt.committedAt }], [{ ...receipt, token: "unexpected" }]]) {
    fs.writeFileSync(statePath, JSON.stringify({ ...state, mutationReceipts }));
    assert.throws(() => new LanAgentAuthority({ statePath }), /Invalid LAN agent authority/);
  }
});

test("runtime validation rejects invalid IDs, grant booleans and bootstrap limits", t => {
  const { authority, statePath } = fixture(t);
  for (const bootstrapTtlMs of [0, -1, NaN, Infinity, 1_800_001]) {
    assert.throws(() => new LanAgentAuthority({ statePath, bootstrapTtlMs }), /limits/);
  }
  for (const maxBootstrapTickets of [0, -1, 1.5, Infinity, 4_097]) {
    assert.throws(() => new LanAgentAuthority({ statePath, maxBootstrapTickets }), /limits/);
  }
  const { ticket } = authority.issueBootstrapTicket();
  for (const nodeId of ["", "../node", " node", "a".repeat(129)]) {
    assert.throws(() => authority.enroll(ticket, nodeId), /Invalid node/);
  }
  const credential = authority.enroll(ticket, "node-a");
  assert.throws(() => authority.setAgentEnabled("node-a", "agent-a", "true" as unknown as boolean), /Invalid agent/);
  assert.equal(authority.authorize(credential.token, "agent-a"), null);
});

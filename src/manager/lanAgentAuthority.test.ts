import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LanAgentAuthority, isLanAgentCredentialToken, inspectLanAgentCredentialState } from "./lanAgentAuthority.js";
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

test("installation inspection validates existing credentials without writing or exposing them", t => {
  const { authority, statePath, dir } = fixture(t);
  enroll(authority);
  const before = fs.readFileSync(statePath);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(inspectLanAgentCredentialState(statePath), { schemaVersion: 2, nodeCount: 1 });
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), files);
  fs.writeFileSync(statePath, '{"schemaVersion":99,"nodes":[]}');
  const incompatible = fs.readFileSync(statePath);
  assert.throws(() => inspectLanAgentCredentialState(statePath), /Invalid computer credential schema/);
  assert.deepEqual(fs.readFileSync(statePath), incompatible);
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
  assert.ok(authority.authenticate(credential.token));
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
  const restarted = new LanAgentAuthority({ statePath });
  const { ticket } = restarted.issueBootstrapTicket();
  const before = fs.readFileSync(statePath, "utf8");
  assert.throws(() => restarted.enroll(ticket, "node-a"), /already enrolled/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.deepEqual(restarted.authenticate(original.token), { nodeId: "node-a" });
  assert.equal(restarted.validateBootstrapTicket(ticket), true);
  assert.equal(restarted.enroll(ticket, "node-b").nodeId, "node-b");
});


test("recoverable enrollment repairs the same node, fences old leases and recovers after restart", t => {
  const { authority, statePath } = fixture(t);
  const original = enroll(authority);
  const before = authority.getSnapshot().nodes[0];
  const lease = authority.acquireConnectionLease(original.token)!;
  const secret = "r".repeat(43); const ticket = authority.issueBootstrapTicket().ticket;
  const repaired = authority.enroll(ticket, "node-a", secret);
  assert.equal(authority.authenticate(original.token), null);
  assert.deepEqual(authority.getSnapshot().nodes[0], before);
  assert.deepEqual(authority.authenticate(repaired.token), { nodeId: "node-a" });
  assert.throws(() => authority.assertConnectionLease(original.token, lease), /revoked or replaced/);
  assert.equal(authority.validateBootstrapTicket(ticket), false);
  const persisted = fs.readFileSync(statePath, "utf8");
  assert.equal(persisted.includes(secret), false); assert.equal(persisted.includes(ticket), false);
  const restarted = new LanAgentAuthority({ statePath });
  assert.deepEqual(restarted.enroll(ticket, "node-a", secret), repaired);
  assert.equal(fs.readFileSync(statePath, "utf8"), persisted);
  assert.throws(() => restarted.enroll(ticket, "node-a", "x".repeat(43)), /expired/);
  assert.throws(() => restarted.enroll(ticket, "node-b", secret), /expired/);
  restarted.revokeNode("node-a");
  assert.throws(() => restarted.enroll(ticket, "node-a", secret), /expired/);
  assert.throws(() => restarted.enroll(restarted.issueBootstrapTicket().ticket, "node-a", "bad"), /Invalid enrollment/);
});


test("malformed, wrong-secret and cross-node credentials never authenticate", t => {
  const { authority } = fixture(t);
  const a = enroll(authority, "node-a");
  const b = enroll(authority, "node-b");
  const wrongSecret = `${a.token.slice(0, -1)}${a.token.endsWith("A") ? "B" : "A"}`;
  for (const token of ["", "Bearer " + a.token, `${a.token}:extra`, wrongSecret,
    a.token.replace("node-a", "node-b"), a.token.replace("lan1:", "lan2:"), "x".repeat(100_000)]) {
    assert.equal(authority.authenticate(token), null);
    assert.equal(authority.authenticate(token), null);
  }
});


test("independent owners reload before writes and never clobber another node grant", t => {
  const { authority, statePath } = fixture(t);
  const other = new LanAgentAuthority({ statePath });
  const a = enroll(authority, "node-a");
  const b = enroll(other, "node-b");
  assert.ok(other.authenticate(a.token));
  assert.ok(authority.authenticate(b.token));
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


test("audit covers committed, rejected and failed operations without credential or hash disclosure", t => {
  const { authority, statePath } = fixture(t);
  const records: RecordedDataMutationAudit[] = [];
  const detach = installDataMutationAuditSink(record => records.push(record));
  t.after(detach);
  const { ticket } = authority.issueBootstrapTicket();
  const credential = authority.enroll(ticket, "node-a");
  const secretHash = JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[0].secretHash;
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

test("legacy session grants migrate once with an exact private snapshot and unchanged computer credential", t => {
  const {authority,statePath,dir}=fixture(t); const {token}=enroll(authority);
  const before=JSON.parse(fs.readFileSync(statePath,"utf8")); before.schemaVersion=1;
  Object.assign(before.nodes[0], {enabledAgentIds:["default"], disabledAgentIds:["old"], agentBindings:[{agentId:"default",provider:"dsh",sessionId:"old-session",managedSessionIds:["child"]}]});
  before.mutationReceipts=[]; const bytes=JSON.stringify(before); fs.writeFileSync(statePath,bytes);
  const migrated=new LanAgentAuthority({statePath}); assert.ok(migrated.authenticate(token));
  const current=JSON.parse(fs.readFileSync(statePath,"utf8")); assert.equal(current.schemaVersion,2);
  assert.deepEqual(Object.keys(current.nodes[0]).sort(),["connectionIncarnation","nodeId","secretHash"]);
  const backups=fs.readdirSync(dir).filter(p=>p.includes("before-explicit-sessions"));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,backups[0]),"utf8"),bytes);
  new LanAgentAuthority({statePath}); assert.equal(fs.readdirSync(dir).filter(p=>p.includes("before-explicit-sessions")).length,1);
});
test("computer leases survive restart but credential replacement and node ABA never revive them",t=>{
 const {authority,statePath}=fixture(t); const {token}=enroll(authority); const lease=authority.acquireConnectionLease(token)!;
 new LanAgentAuthority({statePath}).assertConnectionLease(token,lease);
 const repaired=authority.enroll(authority.issueBootstrapTicket().ticket,"node-a","r".repeat(43));
 assert.throws(()=>authority.assertConnectionLease(repaired.token,lease),/revoked or replaced/);
 const next=authority.acquireConnectionLease(repaired.token)!;authority.revokeNode("node-a");
 const replacement=authority.enroll(authority.issueBootstrapTicket().ticket,"node-a","r".repeat(43));
 assert.throws(()=>authority.assertConnectionLease(replacement.token,next),/revoked or replaced/);
});
test("credential corruption and failed revocation do not overwrite the original state",t=>{
 const {authority,statePath}=fixture(t);const credential=enroll(authority);const bytes=fs.readFileSync(statePath,"utf8");
 const rename=fs.renameSync;const mock=t.mock.method(fs,"renameSync",(from:fs.PathLike,to:fs.PathLike)=>{if(String(to)===statePath)throw new Error("fixture write failure");rename(from,to);});
 assert.throws(()=>authority.revokeNode("node-a"),/write failure/);assert.equal(fs.readFileSync(statePath,"utf8"),bytes);assert.ok(authority.authenticate(credential.token));mock.mock.restore();
 const valid=JSON.parse(bytes);for(const bad of ["{broken",JSON.stringify({schemaVersion:3,nodes:[]}),JSON.stringify({...valid,secret:"unexpected"})]){
 fs.writeFileSync(statePath,bad);assert.throws(()=>new LanAgentAuthority({statePath}),/Invalid/);assert.equal(fs.readFileSync(statePath,"utf8"),bad);
 }
});

test("isolated credential rows preserve their identities and bytes while independent nodes remain usable", t => {
  const { authority, statePath } = fixture(t);
  const bad = enroll(authority, "bad-node"), good = enroll(authority, "good-node");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const original = state.nodes[0];
  const damaged = { ...original, connectionIncarnation: "damaged" };
  const unknown = { retained: "unrecognized record" };
  state.nodes = [original, damaged, state.nodes[1], unknown];
  const before = JSON.stringify(state); fs.writeFileSync(statePath, before);
  const restarted = new LanAgentAuthority({ statePath });
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.equal(restarted.authenticate(bad.token), null);
  assert.ok(restarted.acquireConnectionLease(good.token));
  assert.deepEqual(restarted.getSnapshot().diagnostics, [
    { index: 0, nodeId: "bad-node", reason: "duplicate_identity" },
    { index: 1, nodeId: "bad-node", reason: "duplicate_identity" },
    { index: 3, reason: "invalid_record" }
  ]);
  const ticket = restarted.issueBootstrapTicket().ticket;
  assert.throws(() => restarted.enroll(ticket, "bad-node"), /identity is isolated/);
  assert.throws(() => restarted.revokeNode("bad-node"), /identity is isolated/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  const added = restarted.enroll(ticket, "new-node");
  restarted.setNodeEnabled("good-node", false);
  const written = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(written.nodes[0], original); assert.deepEqual(written.nodes[1], damaged);
  assert.deepEqual(written.nodes[3], unknown);
  const next = new LanAgentAuthority({ statePath });
  assert.ok(next.authenticate(added.token)); assert.equal(next.acquireConnectionLease(good.token), null);
  assert.equal(next.authenticate(bad.token), null);
  const visible = JSON.stringify(next.getSnapshot());
  assert.equal(visible.includes(original.secretHash), false);
  assert.equal(visible.includes(bad.token), false);
});

test("legacy credential migration retains isolated records and one exact recovery snapshot", t => {
  const { authority, statePath, dir } = fixture(t);
  const good = enroll(authority, "good-node");
  const legacy = JSON.parse(fs.readFileSync(statePath, "utf8")); legacy.schemaVersion = 1;
  const damaged = { nodeId: "broken-node", secretHash: "invalid", agentBindings: ["retained"] };
  legacy.nodes.push(damaged);
  const original = JSON.stringify(legacy); fs.writeFileSync(statePath, original);
  const migrated = new LanAgentAuthority({ statePath });
  assert.ok(migrated.authenticate(good.token));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[1], damaged);
  const backups = fs.readdirSync(dir).filter(name => name.includes("before-explicit-sessions"));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(dir, backups[0]!), "utf8"), original);
  assert.equal(new LanAgentAuthority({ statePath }).getSnapshot().diagnostics.length, 1);
});

test("isolated credential rows retain their storage reservation when enrollment reaches capacity", t => {
  const { authority, statePath } = fixture(t);
  const good = enroll(authority, "node-a");
  const record = JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[0];
  const nodes = Array.from({ length: 1999 }, (_, i) => ({ ...record, nodeId: i === 0 ? "node-a" : `node-${i}` }));
  const raw = JSON.stringify({ schemaVersion: 2, nodes: [...nodes, { nodeId: "isolated-node", retained: true }] });
  fs.writeFileSync(statePath, raw);
  const restarted = new LanAgentAuthority({ statePath });
  assert.throws(() => restarted.enroll(restarted.issueBootstrapTicket().ticket, "new-node"), /capacity/);
  assert.equal(fs.readFileSync(statePath, "utf8"), raw);
  assert.ok(new LanAgentAuthority({ statePath }).authenticate(good.token));
});

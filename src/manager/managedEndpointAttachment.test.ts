import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { MessageEndpointManagedAttachmentReference } from "@rabiroute/plugin-sdk";
import { createPlan } from "../roleKnowledge.js";
import { AgentUploadStore } from "./agentUploadStore.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { captureTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { createManagedEndpointAttachmentPort, resolveManagedPlanAttachment, withManagedUpload } from "./managedEndpointAttachment.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const current = () => {};

function request(token?: string) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.10" });
  const input = new IncomingMessage(socket);
  input.method = "POST";
  input.url = "/api/agent/qq/onebot/fixture";
  if (token) input.headers.authorization = `Bearer ${token}`;
  return input;
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-endpoint-attachment-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploads = path.join(root, "uploads");
  const store = new AgentUploadStore({ rootDir: uploads });
  const bytes = Buffer.from("owned upload");
  const upload = store.upload({ owner: { nodeId: "other-computer", agentId: "uploader" }, uploadId: randomUUID(),
    content: bytes, fileName: "fixture.txt", sha256: sha256(bytes) });
  const reference = { fileId: upload.id, fileSha256: upload.sha256 };
  const authority = new LanAgentAuthority({ statePath: path.join(root, "lan-authority.json") });
  const nodeId = "resource-consumer";
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, nodeId);
  const admitted = request(credential.token);
  assert.equal(evaluateLanAgentRequest(admitted, authority, true).kind, "agent");
  captureTrustedLanAgentSource(admitted, "fixture");
  const roleDirectory = (roleId: string) => path.join(root, "roles", roleId);
  const port = createManagedEndpointAttachmentPort(store, roleDirectory, source => {
    if (!authority.getNodeAuthorization(source.nodeId)) throw new Error("Fixture node was revoked.");
  });
  const leases = async () => (await fs.readdir(path.join(uploads, upload.id))).filter(name => name.startsWith(".lease-"));
  return { store, bytes, reference, admitted, authority, nodeId, roleDirectory, port, leases };
}

test("native attachments require the admitted connection and retain the original shared upload lease", async t => {
  const f = await fixture(t);
  const unexpected = () => assert.fail("Unapproved attachment reached the operation");
  await assert.rejects(f.port(request(), f.reference, current, unexpected), /original authorized Manager request/);
  await assert.rejects(f.port(f.admitted, { ...f.reference, fileSha256: "0".repeat(64) }, current, unexpected), /does not match/);
  const raw = { ...f.reference, path: "arbitrary.txt" } as MessageEndpointManagedAttachmentReference;
  await assert.rejects(f.port(f.admitted, raw, current, unexpected), /Invalid managed attachment reference/);
  const pathReturned = await f.port(f.admitted, f.reference, current, async file => {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "fileName", "path", "sha256"]);
    assert.deepEqual(await fs.readFile(file.path), f.bytes);
    assert.equal(file.sha256, f.reference.fileSha256);
    assert.equal(file.bytes, f.bytes.length);
    assert.equal((await f.leases()).length, 1);
    return file.path;
  });
  assert.deepEqual(await f.leases(), []);
  assert.equal(await withManagedUpload(f.store, f.reference, current, file => file.path), pathReturned);
  await assert.rejects(f.port(f.admitted, f.reference, current, async () => { throw new Error("Operation failed."); }), /Operation failed/);
  assert.deepEqual(await f.leases(), []);
});

test("original authority and operation fences are checked on entry, before dispatch, and after completion", async t => {
  const f = await fixture(t);
  let fences = 0;
  await assert.rejects(f.port(f.admitted, f.reference, () => {
    if (++fences === 3) throw new Error("Operation expired during attachment opening.");
  }, () => assert.fail("Expired operation was dispatched")), /expired/);
  assert.deepEqual(await f.leases(), []);
  const outcome = f.port(f.admitted, f.reference, current, async file => {
    f.authority.revokeNode(f.nodeId);
    assert.deepEqual(await fs.readFile(file.path), f.bytes);
    assert.equal((await f.leases()).length, 1);
    return "should not be disclosed after revocation";
  });
  await assert.rejects(outcome, /revok|authoriz|credential/i);
  assert.deepEqual(await f.leases(), []);
  await assert.rejects(f.port(f.admitted, f.reference, current, () => assert.fail("Revoked request reached storage operation")), /revok|authoriz|credential/i);
});

test("the actual Plan owner resolves exact identity and a verified read copy survives source relocation", async t => {
  const f = await fixture(t);
  const roleId = "FixtureRole";
  const bytes = Buffer.from("owned plan attachment");
  await fs.mkdir(f.roleDirectory(roleId), { recursive: true });
  const plan = createPlan(f.roleDirectory(roleId), { id: "fixture-plan", title: "Managed resources", keywords: ["fixture"],
    status: "分析中", currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect attachment", status: "进行中" }],
    attachments: [{ id: "fixture-attachment", name: "fixture.txt", contentBase64: bytes.toString("base64") }] });
  const witness = plan.attachments[0]!;
  const reference = { planAttachment: { roleId, planId: plan.id, attachmentId: witness.id } };
  const resolved = resolveManagedPlanAttachment(f.roleDirectory, reference.planAttachment);
  assert.equal(await fs.realpath(resolved.path), await fs.realpath(witness.path));
  const unexpected = () => assert.fail("A mismatched plan attachment reached the operation");
  await assert.rejects(f.port(f.admitted, { planAttachment: { ...reference.planAttachment, roleId: "OtherRole" } }, current, unexpected), /not found/);
  await fs.writeFile(witness.path, Buffer.alloc(bytes.length));
  await assert.rejects(f.port(f.admitted, reference, current, unexpected), /does not match/);
  await fs.writeFile(witness.path, bytes);
  const copy = await f.port(f.admitted, reference, current, async file => {
    assert.notEqual(file.path, witness.path);
    assert.equal(file.sha256, sha256(bytes));
    assert.equal(file.fileName, witness.name);
    await fs.rename(witness.path, witness.path + ".fixture-relocated");
    assert.deepEqual(await fs.readFile(file.path), bytes);
    return file.path;
  });
  await assert.rejects(fs.access(copy), /ENOENT/);
});

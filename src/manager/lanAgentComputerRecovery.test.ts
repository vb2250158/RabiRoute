import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createLanAgentComputerOperations } from "./lanAgentComputerRoutes.js";
import type { InteractiveContext } from "./lanAgentInteractiveContract.js";
const id = "12345678-1234-4234-8234-123456789abc";
function fixture(message: string, authorized = true) {
  const request = new IncomingMessage(new Socket()); request.headers = {};
  const operation = createLanAgentComputerOperations({ registry: { computerCapabilities: () => ["files"], manageAgent: async () => { throw new Error(message); } }, isManagementRequestAuthorized: () => authorized } as unknown as InteractiveContext)[0]!;
  return async (action: string) => operation.handler({ request, response: new ServerResponse(request), url: new URL("http://fixture.invalid/computer"), path: { instanceId: "fixture-node" }, query: {}, body: { action, uploadId: id } });
}
test("old connector missing-upload status is usable without inventing a terminal outcome", async () => {
  const result = await fixture("Upload not found; do not create a new ID after an uncertain write.")("upload.status");
  assert.equal(result.status, 200); assert.deepEqual(result.body, { code: 0, data: { uploadId: id, state: "absent" } });
});
test("read failures do not claim uncertain writes while real mutation failures retain uncertainty", async () => {
  for (const action of ["file.stat", "file.read", "upload.status"]) {
    const result = await fixture("fixture I/O failure")(action); assert.equal(result.status, 400); assert.equal(Object.hasOwn(result.body as object, "uncertain"), false);
  }
  for (const action of ["upload.begin", "upload.write", "upload.commit"]) {
    const result = await fixture("fixture I/O failure")(action); assert.equal(result.status, 400); assert.equal((result.body as { uncertain: boolean }).uncertain, true);
  }
});
test("missing-upload compatibility does not bypass the original caller authorization", async () => {
  const result = await fixture("Upload not found; do not create a new ID after an uncertain write.", false)("upload.status"); assert.equal(result.status, 401);
});

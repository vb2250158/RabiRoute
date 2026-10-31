import assert from "node:assert/strict";
import test from "node:test";
import { loadPersonaDocument } from "../src/persona/personaDocumentClient";
import { remotePersonaClient } from "../src/persona/remotePersonaReference";

test("persona browser clients preserve documents above old quotas and show server quota errors", async t => {
  const document = "x".repeat(5 * 1024 * 1024);
  const identity = { applicationGenerationId: "generation", managerInstanceId: "instance" };
  let rejected = false;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("bootstrap")) return Response.json({ code: 0, data: { deviceId: "peer" } });
    if (url.endsWith("/meta")) return Response.json({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } });
    if (rejected) return Response.json({ code: -1, error: "PERSONA_FILE_TOO_LARGE", message: "RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=10 exceeded" }, { status: 413 });
    if (url.includes("persona-document")) return new Response(document);
    return Response.json({ code: 0, data: { ...identity, schemaVersion: 1, roleId: "Example", file: "persona.md", document, personaConfig: {}, revision: "a".repeat(64) } });
  });
  assert.equal(await loadPersonaDocument("Example"), document);
  assert.equal((await remotePersonaClient.reference("peer", "Example", "persona.md")).document, document);
  rejected = true;
  await assert.rejects(remotePersonaClient.reference("peer", "Example", "persona.md"), /RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=10/);
});

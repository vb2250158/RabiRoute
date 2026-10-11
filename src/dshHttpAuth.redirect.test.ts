import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { connectDshOwner } from "./dshHttpAuth.js";
import { DshConnectionStore } from "./dshConnectionStore.js";

test("current DSH relative root redirect connects, foreign or token redirects never do", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsh-root-redirect-"));
  const priorFetch = globalThis.fetch;
  const origin = "http://127.0.0.1:39291";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  const store = new DshConnectionStore(path.join(root, "connections.json"), { scheme: "fixture", protect: x => Buffer.from(x).toString("base64"), unprotect: x => Buffer.from(x, "base64").toString() });
  let location = "./", rpcCount = 0;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/") return new Response(null, { status: 303, headers: { location,
      "set-cookie": `${cookieName}=v1.fixture.sig; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
    rpcCount++; const request = JSON.parse(String(init?.body));
    return Response.json({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } });
  };
  try {
    await connectDshOwner(origin + "/?token=fixture", 0, store);
    assert.equal(rpcCount, 1);
    for (location of ["//foreign.example/", "/?token=fixture", "/another-page", "./#fragment"]) {
      await assert.rejects(connectDshOwner(origin + "/?token=fixture", 1, store), /exchange rejected/);
    }
    assert.equal(rpcCount, 1);
  } finally { globalThis.fetch = priorFetch; rmSync(root, { recursive: true, force: true }); }
});

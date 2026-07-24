import assert from "node:assert/strict";
import test from "node:test";
import {
  personaSyncClient,
  type PersonaSyncConflict
} from "../src/persona/personaSyncClient";

test("persona sync UI uses explicit peer, conflict, content, and resolution APIs", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/files/") || url.includes("conflicts/content")) {
      return new Response(new TextEncoder().encode("persona evidence"), {
        status: 200,
        headers: url.includes("conflicts/content")
          ? { "x-rabi-local-sha256": "local-evidence", "x-rabi-remote-sha256": "remote-evidence" }
          : { "x-rabi-sha256": "local-file" }
      });
    }
    const data = url.endsWith("/peers")
      ? { peers: [{ id: "office-pc", name: "Office PC", online: true, capabilities: ["persona-sync"], peerUrls: [] }] }
      : url.endsWith("/index-status")
        ? { state: "ready", watchMode: "recursive", generation: 3, roles: 1, files: 4, totalHashedFiles: 2 }
        : url.endsWith("/auto-status")
          ? { state: "idle", relayOnline: true, pending: false, pendingFullSync: false, pendingRoleCount: 0, retryAttempt: 0 }
        : url.includes("/conflicts?")
          ? { conflicts: [] }
          : url.endsWith("/sync")
            ? {
                peer: { id: "office-pc", name: "Office PC", online: true, capabilities: ["persona-sync"], peerUrls: [] },
                transport: "lan",
                files: [],
                fileConflicts: 1,
                semanticConflicts: [],
                conflicts: 1
              }
            : {
                status: "resolved",
                action: "use_remote",
                conflictId: "conflict-one",
                roleId: "Rabi-A",
                path: "persona.md",
                publish: { status: "published", transport: "lan" }
              };
    return new Response(JSON.stringify({ code: url.endsWith("/sync") ? 1 : 0, data }), {
      status: url.endsWith("/sync") ? 409 : 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const conflict: PersonaSyncConflict = {
    conflictId: "conflict-one",
    roleId: "Rabi-A",
    path: "persona.md",
    size: 12,
    createdAt: "2026-07-24T00:00:00.000Z",
    localHash: "local-hash",
    remoteHash: "remote-hash"
  };

  try {
    await personaSyncClient.peers();
    await personaSyncClient.indexStatus();
    await personaSyncClient.autoStatus();
    await personaSyncClient.conflicts("Rabi-A");
    const sync = await personaSyncClient.sync("office-pc", "Rabi-A");
    assert.equal(sync.conflicts, 1, "HTTP 409 with structured sync data remains inspectable");
    const local = await personaSyncClient.localContent(conflict);
    assert.equal(local.bytes.byteLength, 16);
    assert.equal(local.sha256, "local-file");
    const remote = await personaSyncClient.remoteContent(conflict.conflictId);
    assert.equal(remote.bytes.byteLength, 16);
    assert.equal(remote.sha256, "remote-evidence");
    await personaSyncClient.resolve(conflict, "use_remote");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0]!.url, "/api/persona-sync/peers");
  assert.equal(requests[1]!.url, "/api/persona-sync/index-status");
  assert.equal(requests[2]!.url, "/api/persona-sync/auto-status");
  assert.equal(requests[3]!.url, "/api/persona-sync/conflicts?roleId=Rabi-A");
  assert.deepEqual(JSON.parse(String(requests[4]!.init.body)), { peerId: "office-pc", roleId: "Rabi-A" });
  assert.equal(requests[5]!.url, "/api/persona-sync/files/Rabi-A/persona.md");
  assert.equal(requests[6]!.url, "/api/persona-sync/conflicts/content?conflictId=conflict-one");
  assert.deepEqual(JSON.parse(String(requests[7]!.init.body)), {
    conflictId: "conflict-one",
    action: "use_remote",
    expectedLocalHash: "local-hash"
  });
});

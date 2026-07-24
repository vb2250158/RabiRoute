import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPersonaSyncAcceptance } from "./test-rabi-persona-sync.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeManager({ conflicts = false } = {}) {
  return async (url, init = {}) => {
    const request = new URL(url);
    if (request.pathname === "/api/persona-sync/peers") {
      return jsonResponse(200, { code: 0, data: { peers: [{
        id: "peer-b",
        guid: "guid-b",
        name: "Office PC",
        online: true,
        capabilities: ["persona-sync"],
        peerUrls: ["http://192.168.1.20:45123"]
      }] } });
    }
    if (request.pathname === "/api/persona-sync/manifest") {
      return jsonResponse(200, { code: 0, data: { roles: [{ roleId: "Rabi", files: [{ path: "persona.md" }] }] } });
    }
    if (request.pathname === "/api/persona-sync/sync" && init.method === "POST") {
      return jsonResponse(conflicts ? 409 : 200, { code: conflicts ? 1 : 0, data: {
        transport: "lan",
        files: [{ direction: "converged", status: "unchanged" }],
        fileConflicts: conflicts ? 1 : 0,
        semanticConflicts: [],
        conflicts: conflicts ? 1 : 0,
        baseUrl: "http://192.168.1.20:45123"
      } });
    }
    if (request.pathname === "/api/persona-sync/conflicts") {
      return jsonResponse(200, { code: 0, data: { conflicts: conflicts ? [{
        roleId: "Rabi",
        path: "persona.md",
        peerId: "peer-b",
        remoteDeleted: false,
        conflictPath: "private-path"
      }] : [] } });
    }
    return jsonResponse(404, { message: "not found" });
  };
}

test("persona sync acceptance writes sanitized passing evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-persona-sync-acceptance-"));
  const outputPath = path.join(root, "evidence.json");
  const result = await runPersonaSyncAcceptance({
    managerUrl: "http://127.0.0.1:8790",
    roleId: "Rabi",
    confirmDistinctPhysicalHosts: true,
    outputPath
  }, {
    fetchImpl: fakeManager(),
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.syncPassed, true);
  assert.equal(result.report.formalAcceptanceEligible, true);
  assert.equal(result.report.acceptancePassed, true);
  assert.equal(result.report.sync.transport, "lan");
  const evidence = fs.readFileSync(outputPath, "utf8");
  assert.equal(evidence.includes("192.168.1.20"), false);
  assert.equal(evidence.includes("private-path"), false);
  assert.equal(evidence.includes("baseUrl"), false);
  assert.equal(evidence.includes("Rabi"), false);
  assert.equal(evidence.includes("peer-b"), false);
  assert.equal(evidence.includes("guid-b"), false);
  assert.equal(evidence.includes("Office PC"), false);
});

test("a functional sync is not formal physical evidence without explicit host confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-persona-sync-functional-"));
  const result = await runPersonaSyncAcceptance({ outputPath: path.join(root, "evidence.json") }, {
    fetchImpl: fakeManager(),
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.syncPassed, true);
  assert.equal(result.report.formalAcceptanceEligible, false);
  assert.equal(result.report.acceptancePassed, false);
});

test("persona sync acceptance fails closed when conflicts remain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-persona-sync-conflict-"));
  const result = await runPersonaSyncAcceptance({
    managerUrl: "http://localhost:8790",
    outputPath: path.join(root, "evidence.json")
  }, {
    fetchImpl: fakeManager({ conflicts: true }),
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.report.acceptancePassed, false);
  assert.equal(result.report.status, "conflicts_require_resolution");
  assert.deepEqual(result.report.sync.unresolvedConflictEvidence, {
    total: 1,
    remoteDeletionConflicts: 0,
    editedOrDivergedConflicts: 1
  });
});

test("persona sync acceptance refuses non-loopback Manager URLs", async () => {
  await assert.rejects(
    () => runPersonaSyncAcceptance({ managerUrl: "https://manager.example.com" }, { fetchImpl: fakeManager() }),
    /loopback Manager URL/
  );
});

test("persona sync acceptance explains a stale Manager serving WebGUI HTML", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-persona-sync-stale-manager-"));
  const result = await runPersonaSyncAcceptance({
    outputPath: path.join(root, "evidence.json")
  }, {
    fetchImpl: async () => new Response("<html>WebGUI</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.error, "manager_non_json_response");
});

import assert from "node:assert/strict";
import test from "node:test";
import { scanDshAgentAdapter } from "./agentAdapters/dshManagerApi.js";
import { resolveDshBaseUrl, type DshLocalDiscovery } from "./dshDiscovery.js";

const missing: DshLocalDiscovery = { installed: true, homeDir: "fixture", installCandidates: [], discoveredBaseUrls: [], warnings: [] };
test("DSH unconfigured scan never guesses a port or performs RPC", async () => {
  assert.throws(() => resolveDshBaseUrl(undefined, missing), /not configured or discovered/);
  const result = await scanDshAgentAdapter({ rootDir: process.cwd(), discoverLocalDsh: () => missing,
    checkHttpEndpoint: async () => { throw new Error("No guessed probe"); },
    listDshSessions: async () => { throw new Error("No unconfigured RPC"); } });
  assert.deepEqual(result.agents.dsh.endpoints, []);
  assert.match(result.agents.dsh.warnings!.join(" "), /未配置或发现/);
});

test("DSH preserves an explicit target even if another discovered owner is healthy", async () => {
  const seen: string[] = [];
  const explicit = "http://127.0.0.1:49121";
  await scanDshAgentAdapter({ rootDir: process.cwd(), runtimes: [{ definition: { dshBaseUrl: explicit } }],
    discoverLocalDsh: () => ({ ...missing, discoveredBaseUrls: ["http://127.0.0.1:49122"] }),
    checkHttpEndpoint: async url => url !== explicit,
    listDshSessions: async query => { seen.push(query.baseUrl); return []; } });
  assert.deepEqual(seen, [explicit]);
});

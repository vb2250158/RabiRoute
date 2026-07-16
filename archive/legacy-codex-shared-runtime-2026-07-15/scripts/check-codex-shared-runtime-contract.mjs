import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const client = read("src", "codexAppServerClient.ts");
const runtime = read("src", "codexSharedRuntime.ts");
const owner = read("src", "manager", "codexSharedRuntimeOwner.ts");
const packageJson = JSON.parse(read("package.json"));

assert.match(runtime, /CODEX_SHARED_RUNTIME_URL = "ws:\/\/127\.0\.0\.1:4510"/);
assert.match(client, /new WebSocket\(CODEX_SHARED_RUNTIME_URL\)/);
assert.doesNotMatch(client, /spawn\(|stdio:\/\//);
assert.match(owner, /ensureCodexSharedRuntime/);
assert.equal(packageJson.scripts["codex:shared"], "node --import tsx scripts/codex-shared.ts");

for (const file of ["src/codexRuntime.ts", "src/codexAppServerClient.ts"]) {
  const source = read(...file.split("/"));
  assert.doesNotMatch(source, /codex-ipc|thread-follower|app-server-stdio/);
}

console.log("Codex shared Runtime contract OK: one owner, one WS endpoint, no live stdio/private-IPC fallback.");

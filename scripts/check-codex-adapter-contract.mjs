import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const bridge = read("src", "codexDesktopBridge.ts");
const runtime = read("src", "codexRuntime.ts");
const sessionResolver = read("src", "codexSessionResolver.ts");
const manager = read("src", "manager", "controlPlaneRoutes.ts");
const overview = read("ribiwebgui", "src", "pages", "OverviewPage.vue");
const routeConfig = read("ribiwebgui", "src", "pages", "RouteConfigPage.vue");
const gatewayStore = read("ribiwebgui", "src", "stores", "gatewayStore.ts");
const sessionBinding = read("src", "shared", "codexSessionBinding.ts");
const runtimeLog = read("ribiwebgui", "src", "pages", "RuntimeLogPage.vue");
const adapterSkill = read("skills", "create-rabiroute-agent-adapter", "SKILL.md");
const ownerFirstGate = read("skills", "create-rabiroute-agent-adapter", "references", "owner-first-design-gate.md");
const packageJson = JSON.parse(read("package.json"));
const nestedDist = path.join(root, "dist", "src");
const builtAgentThreadsPath = path.join(root, "dist", "agentThreads.js");

assert.match(bridge, /CODEX_DESKTOP_IPC_PATH[\s\S]*codex-ipc/);
assert.match(bridge, /thread-follower-start-turn/);
assert.match(bridge, /thread-follower-steer-turn/);
assert.match(bridge, /codex:\/\/threads\//);
assert.match(bridge, /不会启动备用 Runtime/);
assert.match(runtime, /desktopBridge\.deliver/);
assert.match(runtime, /resolveAndDeliverCodexSession/);
assert.match(sessionResolver, /resolveCodexSession/);
assert.match(sessionResolver, /dependencies\.deliver/);
assert.match(runtime, /bootstrapEmptyDesktopThread/);
assert.match(runtime, /thread\/start/);
assert.doesNotMatch(runtime, /turn\/start|turn\/steer/);
assert.match(runtime, /codex_app_server_ws_url/);
assert.doesNotMatch(manager, /ensureCodexSharedRuntime|stopOwnedCodexSharedRuntime/);
for (const source of [overview, routeConfig, runtimeLog]) {
  assert.doesNotMatch(source, /app-server-stdio|app-server stdio|共用同一个 Runtime/);
}
assert.match(routeConfig, /Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime/);
assert.doesNotMatch(routeConfig, /createIfMissing:\s*true/);
assert.match(routeConfig, /createIfMissing:\s*false/);
assert.doesNotMatch(routeConfig, /@blur="ensureCodexThreadBinding"/);
assert.match(gatewayStore, /await bindCodexSessionForSave\(selectedGateway\.value/);
assert.match(sessionBinding, /createIfMissing:\s*true/);
assert.equal(packageJson.scripts["configure:codex-desktop"], undefined);
assert.equal(packageJson.scripts["codex:shared"], undefined);
assert.match(adapterSkill, /冻结用户可观察合同/);
assert.match(adapterSkill, /一个 adapter 只能有一条真实消息执行路径/);
assert.match(ownerFirstGate, /同一 session ID ≠ 同一 live task owner/);
assert.match(ownerFirstGate, /RabiRoute event -> adapter -> transport -> exact session\/task owner -> turn -> observable result/);
assert.equal(fs.existsSync(nestedDist), false, "Backend build must not leave a shadow dist/src runtime tree.");
if (fs.existsSync(builtAgentThreadsPath)) {
  assert.match(fs.readFileSync(builtAgentThreadsPath, "utf8"), /codexSessionResolver/,
    "The runnable dist/agentThreads.js must contain the canonical resolver.");
}

console.log("Codex adapter contract OK: actual messages have one owner (Desktop IPC), with no shared endpoint or fallback runtime; the Agent adapter skill retains its owner-first design gate.");

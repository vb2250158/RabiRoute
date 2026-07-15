import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const codexVersion = packageJson.dependencies?.["@openai/codex"];
assert.match(String(codexVersion), /^\d+\.\d+\.\d+$/, "@openai/codex must be pinned exactly");

const remoteBridgeDir = path.join(rootDir, "plugin-adapters", "remote-agent-rabiroute");
const remoteBridgePackage = JSON.parse(fs.readFileSync(path.join(remoteBridgeDir, "package.json"), "utf8"));
assert.equal(remoteBridgePackage.dependencies?.["@openai/codex"], codexVersion, "Remote Agent must pin the same Codex runtime");
const remoteBridgeSource = fs.readdirSync(remoteBridgeDir)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .map((name) => fs.readFileSync(path.join(remoteBridgeDir, name), "utf8"))
  .join("\n");
for (const [label, pattern] of [
  ["danger-full-access sandbox", /dangerFullAccess/],
  ["experimental app-server API", /experimentalApi\s*:\s*true/],
  ["WebSocket-era JSON-RPC envelope", /jsonrpc\s*:/],
  ["private session index", /session_index\.jsonl/],
  ["detached app-server URL", /REMOTE_AGENT_CODEX_APP_SERVER_URL/],
  ["public default password", /DEFAULT_PASSWORD|["']123456["']|123456\s*\(default\)/],
  ["obsolete bridge protocol", /PROTOCOL_VERSION\s*=\s*2/]
]) {
  assert.doesNotMatch(remoteBridgeSource, pattern, `Remote Agent reintroduced ${label}`);
}
for (const pattern of [
  /"initialized"/,
  /"model\/list"/,
  /"thread\/resume"/,
  /type:\s*"workspaceWrite"/,
  /PROTOCOL_VERSION\s*=\s*3/,
  /createHmac/,
  /serverProof/,
  /resolveRealFileWithinRoots/,
  /replyTextFromCompletedTurn/,
  /KeyedTaskQueue/
]) {
  assert.match(remoteBridgeSource, pattern, `Remote Agent is missing required app-server contract: ${pattern}`);
}

const remoteManagerSource = fs.readFileSync(path.join(rootDir, "src", "messageEndpoints", "remoteAgentManager.ts"), "utf8");
for (const pattern of [
  /REMOTE_AGENT_PROTOCOL_VERSION\s*=\s*3/,
  /challengeAnswered/,
  /serverProof/,
  /10 \* 1024 \* 1024/,
  /25 \* 1024 \* 1024/
]) {
  assert.match(remoteManagerSource, pattern, `Remote Agent manager is missing protocol/security contract: ${pattern}`);
}
assert.doesNotMatch(remoteManagerSource, /["']123456["']/, "Remote Agent manager reintroduced a public default password");

const runtimeSource = fs.readFileSync(path.join(rootDir, "src", "codexRuntime.ts"), "utf8");
const agentThreadsSource = fs.readFileSync(path.join(rootDir, "src", "agentThreads.ts"), "utf8");
const appServerClientSource = fs.readFileSync(path.join(rootDir, "src", "codexAppServerClient.ts"), "utf8");
const managerApiSource = fs.readFileSync(path.join(rootDir, "src", "agentAdapters", "managerApi.ts"), "utf8");
const rootLiveCodexSource = [
  runtimeSource,
  appServerClientSource,
  managerApiSource,
  fs.readFileSync(path.join(rootDir, "src", "manager", "controlPlaneRoutes.ts"), "utf8"),
  fs.readFileSync(path.join(rootDir, "src", "manager", "codexRuntimeState.ts"), "utf8")
].join("\n");
for (const [label, pattern] of [
  ["private session index", /session_index\.jsonl/],
  ["Desktop IPC environment", /CODEX_DESKTOP_IPC|CODEX_DIRECT_NOTIFY/],
  ["detached app-server URL", /CODEX_APP_SERVER_URL/],
  ["experimental app-server API", /experimentalApi\s*:\s*true/],
  ["WebSocket-era JSON-RPC envelope", /jsonrpc\s*:/]
]) {
  assert.doesNotMatch(rootLiveCodexSource, pattern, `Root Codex path reintroduced ${label}`);
}
for (const pattern of [
  /request\("model\/list"/,
  /request\("thread\/resume"/,
  /candidate\.status === "inProgress"/,
  /request\("turn\/steer",\s*\{[\s\S]*?clientUserMessageId/,
  /text_elements:\s*\[\]/,
  /clientUserMessageId/
]) {
  assert.match(runtimeSource, pattern, `Codex runtime builder is missing required contract: ${pattern}`);
}
assert.doesNotMatch(runtimeSource, /RABIROUTE_CODEX_MODEL|CODEX_MODEL/, "Codex runtime must not silently override an empty agentModel");
const notificationTurnSource = runtimeSource.slice(runtimeSource.indexOf("async function startNotificationTurn("));
assert.match(notificationTurnSource, /type:\s*"workspaceWrite"/, "Default Codex notifications must use workspaceWrite");
assert.doesNotMatch(notificationTurnSource, /dangerFullAccess/, "Default Codex notifications must not use dangerFullAccess");
assert.match(
  runtimeSource,
  /if \(sandbox === "danger-full-access"\) return \{ type: "dangerFullAccess" \};/,
  "Explicit Agent thread requests must map danger-full-access to the app-server sandbox policy"
);
assert.match(
  agentThreadsSource,
  /fallback: CodexTurnSandbox = "workspace-write"/,
  "Agent thread requests must default to workspace-write"
);
assert.match(
  agentThreadsSource,
  /value === "read-only" \|\| value === "workspace-write" \|\| value === "danger-full-access"/,
  "Agent thread requests must validate the explicit sandbox allowlist"
);
assert.match(appServerClientSource, /writeMessageToChild/, "App-server responses must stay bound to their source process");
assert.match(appServerClientSource, /code !== -32001/, "App-server overload handling must remain explicit");
const detectCodexBinsSource = managerApiSource.slice(
  managerApiSource.indexOf("async function detectCodexBins"),
  managerApiSource.indexOf("async function detectCopilotBins")
);
assert.match(detectCodexBinsSource, /node_modules[\s\S]*@openai[\s\S]*codex/, "Codex readiness must use the project-pinned runtime");
assert.doesNotMatch(detectCodexBinsSource, /where\.exe|\bwhich\b/, "Global PATH Codex must not satisfy runtime readiness");

const canonicalAdapterConsumers = [
  fs.readFileSync(path.join(rootDir, "src", "shared", "gatewayConfigModel.ts"), "utf8"),
  fs.readFileSync(path.join(rootDir, "ribiwebgui", "src", "stores", "gatewayStore.ts"), "utf8"),
  fs.readFileSync(path.join(rootDir, "ribiwebgui", "src", "components", "QuickSetupDialog.vue"), "utf8"),
  fs.readFileSync(path.join(rootDir, "examples", "rabilink-aiui", "utils", "config-surface.js"), "utf8")
].join("\n");
assert.doesNotMatch(
  canonicalAdapterConsumers,
  /["']codex(?:Desktop|App)["']/,
  "Historical Codex adapter ids must remain isolated to the backend config migration boundary"
);

const codexJs = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
assert.ok(fs.existsSync(codexJs), `Missing pinned Codex runtime: ${codexJs}`);

const version = spawnSync(process.execPath, [codexJs, "--version"], {
  cwd: rootDir,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(version.status, 0, version.stderr || "codex --version failed");
assert.match(version.stdout, new RegExp(`\\b${codexVersion.replaceAll(".", "\\.")}\\b`));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-codex-schema-${codexVersion}-`));
try {
  const generated = spawnSync(process.execPath, [codexJs, "app-server", "generate-ts", "--out", tempDir], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(generated.status, 0, generated.stderr || "codex app-server generate-ts failed");

  const clientRequest = fs.readFileSync(path.join(tempDir, "ClientRequest.ts"), "utf8");
  const clientNotification = fs.readFileSync(path.join(tempDir, "ClientNotification.ts"), "utf8");
  const serverRequest = fs.readFileSync(path.join(tempDir, "ServerRequest.ts"), "utf8");
  const threadStartParams = fs.readFileSync(path.join(tempDir, "v2", "ThreadStartParams.ts"), "utf8");
  const turnStartParams = fs.readFileSync(path.join(tempDir, "v2", "TurnStartParams.ts"), "utf8");
  const sandboxPolicy = fs.readFileSync(path.join(tempDir, "v2", "SandboxPolicy.ts"), "utf8");
  const userInput = fs.readFileSync(path.join(tempDir, "v2", "UserInput.ts"), "utf8");
  const model = fs.readFileSync(path.join(tempDir, "v2", "Model.ts"), "utf8");
  const thread = fs.readFileSync(path.join(tempDir, "v2", "Thread.ts"), "utf8");
  const turnStatus = fs.readFileSync(path.join(tempDir, "v2", "TurnStatus.ts"), "utf8");
  const turnSteerParams = fs.readFileSync(path.join(tempDir, "v2", "TurnSteerParams.ts"), "utf8");
  const commandApproval = fs.readFileSync(path.join(tempDir, "v2", "CommandExecutionApprovalDecision.ts"), "utf8");
  const fileApproval = fs.readFileSync(path.join(tempDir, "v2", "FileChangeApprovalDecision.ts"), "utf8");
  for (const method of ["initialize", "model/list", "thread/list", "thread/read", "thread/resume", "thread/start", "thread/name/set", "turn/start", "turn/steer"]) {
    assert.match(clientRequest, new RegExp(`\\"${method.replace("/", "\\/")}\\"`), `Missing app-server method: ${method}`);
  }
  assert.match(clientNotification, /"initialized"/);
  assert.match(serverRequest, /item\/commandExecution\/requestApproval/);
  assert.match(serverRequest, /item\/fileChange\/requestApproval/);
  assert.match(serverRequest, /item\/permissions\/requestApproval/);
  assert.match(threadStartParams, /approvalPolicy\?/);
  assert.match(threadStartParams, /sandbox\?/);
  assert.match(turnStartParams, /sandboxPolicy\?/);
  assert.match(sandboxPolicy, /"workspaceWrite"/);
  assert.match(sandboxPolicy, /writableRoots/);
  assert.match(sandboxPolicy, /networkAccess/);
  assert.match(userInput, /text_elements/);
  assert.match(model, /isDefault/);
  assert.match(thread, /turns: Array<Turn>/);
  assert.match(turnStatus, /"inProgress"/);
  assert.match(turnSteerParams, /clientUserMessageId\?/);
  assert.match(commandApproval, /"decline"/);
  assert.match(fileApproval, /"decline"/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Codex app-server contract OK (${codexVersion}, stdio/JSONL).`);

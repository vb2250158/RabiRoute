import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const files = {
  appJson: path.join(projectRoot, "app.json"),
  appJs: path.join(projectRoot, "app.js"),
  agentsMd: path.join(projectRoot, "AGENTS.md"),
  craftRelease: path.join(projectRoot, "craft-release.json"),
  pageInk: path.join(projectRoot, "pages", "home", "index.ink"),
  craftUploadPowerShell: path.join(projectRoot, "scripts", "Invoke-RabiLinkAiuiCraftUpload.ps1"),
  craftMetadataPowerShell: path.join(projectRoot, "scripts", "RabiLinkAiuiCraftMetadata.ps1"),
  craftBrowserHelper: path.join(projectRoot, "scripts", "craft-browser-upload-helper.js"),
  craftEmbeddedHelper: path.join(projectRoot, "scripts", "craft-browser-embedded-aix-upload-helper.template.js"),
  craftEmbeddedLauncher: path.join(projectRoot, "scripts", "Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1"),
  configSurface: path.join(projectRoot, "utils", "config-surface.js"),
  rabilinkApi: path.join(projectRoot, "utils", "rabilink-api.js"),
  relayServer: path.resolve(projectRoot, "..", "..", "scripts", "rabilink-relay-server.mjs"),
  gatewayModel: path.resolve(projectRoot, "..", "..", "src", "shared", "gatewayConfigModel.ts")
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function parseJsonFile(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    throw new Error(`${path.relative(projectRoot, file)} is not valid JSON: ${error.message}`);
  }
}

function extractBlock(source, tagName, marker = "") {
  const escapedMarker = marker ? `[^>]*${marker}[^>]*` : "[^>]*";
  const re = new RegExp(`<${tagName}${escapedMarker}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = source.match(re);
  return match ? match[1].trim() : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkSyntax(source, label) {
  const tmp = path.join(os.tmpdir(), `rabilink-aiui-check-${process.pid}-${label.replace(/[^A-Za-z0-9_.-]+/g, "-")}.mjs`);
  fs.writeFileSync(tmp, source, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (error) {
    const detail = Buffer.concat([
      error.stdout || Buffer.alloc(0),
      error.stderr || Buffer.alloc(0)
    ]).toString("utf8");
    throw new Error(`${label} has invalid JavaScript syntax:\n${detail}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function extractBrowserFunction(source, functionName, nextFunctionName) {
  const match = source.match(new RegExp(
    `function ${functionName}\\(text\\) \\{([\\s\\S]*?)\\r?\\n  \\}\\r?\\n\\r?\\n  function ${nextFunctionName}`
  ));
  assert(match, `Could not extract ${functionName} from Craft browser helper.`);
  return Function(`"use strict"; return function ${functionName}(text) {${match[1]}\n};`)();
}

const appJson = parseJsonFile(files.appJson);
assert(Array.isArray(appJson.pages), "app.json must define pages array.");
assert(appJson.pages.includes("pages/home/index"), "app.json must include pages/home/index.");
assert(appJson.pages[0] === "pages/home/index", "pages/home/index must remain the safe default entry page.");
assert(appJson.pages.length === 1, "AIUI must keep both modes on one page so entering Interactive InkView cannot trigger page reconciliation.");

const pageInk = read(files.pageInk);
const defSource = extractBlock(pageInk, "script", "def");
assert(defSource, "pages/home/index.ink must include <script def>.");
const pageDefinition = JSON.parse(defSource);
const toolSchema = pageDefinition.schema?.data;
const craftRelease = parseJsonFile(files.craftRelease);
assert(craftRelease.agentName === "RabiLink", "Craft release agentName must match the bound cloud agent.");
assert(/^\d+\.\d+\.\d+$/.test(craftRelease.version), "Craft release version must be a semantic version.");
assert(typeof pageDefinition.description === "string" && pageDefinition.description.trim(), "AIUI page must declare a page-tool description.");
assert(toolSchema?.type === "object", "AIUI page must declare schema.data as an object.");
for (const property of ["token", "mode", "surface", "panel", "intent", "targetDeviceId"]) {
  assert(toolSchema?.properties?.[property], `AIUI page schema must declare ${property}.`);
}
assert(
  JSON.stringify(toolSchema.properties.mode.enum) === JSON.stringify(["transcription", "configuration"]),
  "AIUI page mode schema must expose exactly the transcription and configuration modes."
);
assert(toolSchema.required?.includes("token"), "AIUI page schema must require token for variable binding.");
assert(toolSchema.additionalProperties === false, "AIUI page schema must reject undeclared tool inputs.");

const expectedCraftTools = [{
  type: "function",
  target: "_current",
  layout: { width: 448, height: 150 },
  function: {
    name: "index",
    description: pageDefinition.description,
    parameters: toolSchema,
  },
}];
const browserHelperSource = read(files.craftBrowserHelper);
const browserToolsMatch = browserHelperSource.match(/const DEFAULT_TOOLS = ([\s\S]*?);\r?\n\r?\n  const DEFAULTS/);
assert(browserToolsMatch, "Craft browser upload helper must declare DEFAULT_TOOLS.");
const browserDefaultTools = Function(`"use strict"; return (${browserToolsMatch[1]});`)();
assert(
  JSON.stringify(browserDefaultTools) === JSON.stringify(expectedCraftTools),
  "Craft browser upload helper tools must match pages/home/index.ink exactly."
);
assert(browserHelperSource.includes(`agentName: ${JSON.stringify(craftRelease.agentName)}`), "Craft browser helper must use craft-release.json agentName.");
assert(browserHelperSource.includes(`version: ${JSON.stringify(craftRelease.version)}`), "Craft browser helper must use craft-release.json version.");
const embeddedHelperSource = read(files.craftEmbeddedHelper);
const uploadPowerShellSource = read(files.craftUploadPowerShell);
const metadataPowerShellSource = read(files.craftMetadataPowerShell);
const embeddedLauncherSource = read(files.craftEmbeddedLauncher);
for (const [label, source] of [
  ["browser helper", browserHelperSource],
  ["embedded helper", embeddedHelperSource],
  ["PowerShell uploader", uploadPowerShellSource],
]) {
  assert(source.includes("RECORD_AUDIO,SPEECH_RECOGNITION,INTERNET"), `${label} must request the complete audio permission set.`);
}
for (const [label, source] of [
  ["browser helper", browserHelperSource],
  ["embedded helper", embeddedHelperSource],
]) {
  assert(source.includes("response.ok && sse.complete && !sse.hasError"), `${label} must reject HTTP 200 streams without done or with error.`);
  assert(source.includes("stream_complete") && source.includes("stream_error"), `${label} must record SSE completion and failure separately.`);
  const parseSse = extractBrowserFunction(source, "parseSse", "refreshReportBase");
  const completedSse = parseSse('event: progress\ndata: {"stage":"upload"}\n\nevent: done\ndata: {"stage":"done"}\n\n');
  assert(completedSse.complete && !completedSse.hasError, `${label} must accept a done SSE stream without error.`);
  const failedSse = parseSse('event: error\ndata: {"message":"missing tools"}\n\n');
  assert(!failedSse.complete && failedSse.hasError && failedSse.errors.includes("missing tools"), `${label} must reject an SSE error hidden behind HTTP 200.`);
}
assert(metadataPowerShellSource.includes('pages/home/index.json'), "Craft metadata helper must read the page definition from the AIX.");
assert(uploadPowerShellSource.includes("Get-RabiLinkAiuiCraftToolsJson"), "PowerShell uploader must derive default tools from the AIX.");
assert(uploadPowerShellSource.includes("$sseStatus.Complete") && uploadPowerShellSource.includes("$sseStatus.HasError"), "PowerShell uploader must validate the SSE terminal state.");
assert(embeddedHelperSource.includes("__RABILINK_TOOLS_JSON_STRING__"), "Embedded upload template must reserve generated AIX tools metadata.");
assert(embeddedHelperSource.includes(`agentName: ${JSON.stringify(craftRelease.agentName)}`), "Embedded helper must use craft-release.json agentName.");
assert(embeddedHelperSource.includes(`version: ${JSON.stringify(craftRelease.version)}`), "Embedded helper must use craft-release.json version.");
assert(embeddedLauncherSource.includes("Get-RabiLinkAiuiCraftToolsJson") && embeddedLauncherSource.includes("__RABILINK_TOOLS_JSON_STRING__"), "Embedded upload launcher must inject tools derived from the selected AIX.");
assert(!/ink:(?:if|elif|else)\b/.test(pageInk), "AIUI home page must not use structural conditions that can deadlock Craft Ink reconciliation.");
assert(!/<\/?block\b/.test(pageInk), "AIUI home page must keep a stable mounted view tree without conditional block nodes.");
assert(
  (pageInk.match(/<scroll-view\b/g) || []).length === 0,
  "AIUI home page must not mount scroll-view nodes; Ink 0.13 corrupts their layout parent during Craft card-to-immersive resize."
);
assert(pageInk.includes('class="unifiedModeHud {{modeFrameRelayout'), "AIUI home page must mount one stable immersive HUD for both product modes.");
assert((pageInk.match(/class="compactCard \{\{modeFrameRelayout/g) || []).length === 1, "AIUI home page must mount one stable compact card for both product modes.");
assert(!pageInk.includes("transcriptionHud") && !pageInk.includes("configurationAssistantHud"), "The two legacy mode-specific HUD trees must be removed.");
assert(!pageInk.includes('class="configurationModeHost {{isConfigurationMode'), "The old manual configuration dashboard must not remain selectable.");
assert(!pageInk.includes('class="legacyConfigurationModeHost'), "The old manual configuration markup must be removed from the AIX page.");
assert(!pageInk.includes('Token {{maskedToken}}'), "The assistant page must not expose the old token editor or credential row.");
assert(!pageInk.includes("modeHidden"), "Mode switching must update one stable HUD instead of hiding parallel mode trees.");
assert(pageInk.includes("commitModeFrame") && pageInk.includes(".modeFrameRelayout"), "Mode switching must force a complete single-tree Ink relayout.");
assert(pageInk.includes("hudVisibleSnapshot") && pageInk.includes("...this.hudVisibleSnapshot()"), "Every masked Ink update must restore all visible HUD bindings in one snapshot.");
assert(pageInk.includes("TRANSCRIPTION_CLOCK_REFRESH_MS") && pageInk.includes("opacity: 0"), "The Ink relayout guard must mask its bounded repaint frame and throttle duration updates.");
assert(pageInk.includes("toggleModePrimaryAction") && pageInk.includes("retryModeAction"), "Stable mode utilities must delegate through mode-aware actions.");
for (const behavior of [
  "startTranscription()",
  "scheduleTranscriptionRestart(",
  "flushTranscriptQueue()",
  "requestConfigurationAssistant(",
  "switchToTranscription(",
  "executeConfigurationIntent(",
  "pollAgentMessages("
]) {
  assert(pageInk.includes(behavior), `AIUI dual-mode runtime is missing ${behavior}.`);
}
assert(
  read(files.rabilinkApi).includes('"/rokid/rabilink/input"')
    && read(files.rabilinkApi).includes('`/rokid/rabilink/messages?${query.toString()}`')
    && !read(files.rabilinkApi).includes('"/rokid/rabilink/tasks"'),
  "AIUI must use a message input endpoint and one cursor-based downlink stream without a glasses-side task lifecycle."
);
const agentsMd = read(files.agentsMd);
assert(agentsMd.includes("mode=transcription") && agentsMd.includes("mode=configuration"), "Agent instructions must route both product modes through the same page tool.");
assert(agentsMd.includes("不需要额外导入 RabiLinkMessage"), "Agent instructions must explicitly remove the separate RabiLinkMessage plugin requirement.");
assert(agentsMd.includes("同一个 AIUI 页面内切换") && !agentsMd.includes("this.finish()"), "Agent instructions must preserve in-page bidirectional mode switching without finish().");
assert(agentsMd.includes("连接对话") && agentsMd.includes("原生 Agent"), "Agent instructions must document the agreed mode name and native-Agent configuration ownership.");

const setupSource = extractBlock(pageInk, "script", "setup");
assert(setupSource, "pages/home/index.ink must include <script setup>.");
checkSyntax(setupSource, "pages/home/index.ink#setup");

const appSource = read(files.appJs);
checkSyntax(appSource, "app.js");

for (const file of fs.readdirSync(path.join(projectRoot, "utils"))) {
  if (file.endsWith(".js")) {
    const source = read(path.join(projectRoot, "utils", file));
    checkSyntax(source, `utils/${file}`);
  }
}

const tokenLike = /rbl_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}/;
for (const file of [
  files.appJson,
  files.appJs,
  files.agentsMd,
  files.pageInk,
  ...fs.readdirSync(path.join(projectRoot, "utils")).map((name) => path.join(projectRoot, "utils", name))
]) {
  assert(!tokenLike.test(read(file)), `${path.relative(projectRoot, file)} appears to contain a real token.`);
}

const stagingCheckRoot = path.join(os.tmpdir(), `rabilink-aiui-package-check-${process.pid}`);
try {
  await buildPackageStaging(stagingCheckRoot);
  const packageFiles = new Set();
  for (const entry of fs.readdirSync(stagingCheckRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const fullPath = path.join(entry.parentPath, entry.name);
      packageFiles.add(path.relative(stagingCheckRoot, fullPath).replaceAll("\\", "/"));
    }
  }
  for (const required of [
    ".aixignore",
    "AGENTS.md",
    "VERSION",
    "app.js",
    "app.json",
    "pages/home/index.js",
    "pages/home/index.json",
    "pages/home/index.wxml",
    "pages/home/index.wxss"
  ]) {
    assert(packageFiles.has(required), `Compiled AIX staging is missing ${required}.`);
  }
  for (const sourceOnly of [
    "README.md",
    "pages/home/index.ink",
    "utils/config-surface.js",
    "utils/rabilink-api.js",
    "utils/rabilink-defaults.js",
    "utils/rabilink-store.js",
    "utils/view-model.js",
    "utils/voice-command.js",
    "scripts/Package-RabiLinkAiui.ps1",
    "scripts/Build-RabiLinkAiuiPackage.mjs",
    "scripts/check-rabilink-aiui.mjs",
    "package.json"
  ]) {
    assert(!packageFiles.has(sourceOnly), `Compiled AIX staging should not include source-only file ${sourceOnly}.`);
  }
  JSON.parse(read(path.join(stagingCheckRoot, "pages", "home", "index.json")));
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\s*$/i.test(read(path.join(stagingCheckRoot, "VERSION"))),
    "Compiled AIX VERSION must be a generated UUID, not the npm package version."
  );
  const compiledPageScript = read(path.join(stagingCheckRoot, "pages", "home", "index.js"));
  const compiledPageMarkup = read(path.join(stagingCheckRoot, "pages", "home", "index.wxml"));
  checkSyntax(compiledPageScript, "compiled pages/home/index.js");
  assert(
    (compiledPageMarkup.match(/<scroll-view\b/g) || []).length === 0,
    "Compiled Craft page must not contain scroll-view nodes."
  );
  assert(!packageFiles.has("pages/config/index.js"), "Compiled AIX must not contain a second configuration page.");
  const compiledImports = [...compiledPageScript.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert(
    compiledImports.every((specifier) => specifier === "wx"),
    `Compiled Craft page must be self-contained; unexpected imports: ${compiledImports.join(", ")}`
  );
} finally {
  fs.rmSync(stagingCheckRoot, { recursive: true, force: true });
}

function exportedArrayKeys(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  assert(match, `utils/config-surface.js must export ${name}.`);
  return [...match[1].matchAll(/key:\s*"([^"]+)"/g)].map((item) => item[1]);
}

function gatewayDefinitionFields(source) {
  const start = source.indexOf("export type GatewayDefinition = {");
  assert(start >= 0, "GatewayDefinition type was not found.");
  const end = source.indexOf("};", start);
  assert(end > start, "GatewayDefinition type block was not closed.");
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map((item) => item[1]);
}

const configSurface = read(files.configSurface);
const coveredGatewayFields = new Set([
  ...exportedArrayKeys(configSurface, "GATEWAY_SCALAR_FIELDS"),
  ...exportedArrayKeys(configSurface, "GATEWAY_JSON_FIELDS")
]);
const missingGatewayFields = gatewayDefinitionFields(read(files.gatewayModel))
  .filter((field) => !coveredGatewayFields.has(field));
assert(
  missingGatewayFields.length === 0,
  `AIUI advanced config fields do not cover GatewayDefinition fields: ${missingGatewayFields.join(", ")}`
);

const configSurfaceModule = await import(`${pathToFileURL(files.configSurface).href}?check=${Date.now()}`);
const addedGateway = configSurfaceModule.appendDefaultGateway([
  configSurfaceModule.createDefaultGateway(1)
]);
assert(
  addedGateway.gateway.id === "config-2" && addedGateway.gateway.gatewayPort === 8791,
  "appendDefaultGateway must follow WebGUI default gateway numbering."
);
const duplicatedGateway = configSurfaceModule.duplicateSelectedGateway(addedGateway.gateways, 0);
assert(
  duplicatedGateway.gateway.id === "config-3"
    && duplicatedGateway.gateway.enabled === false
    && duplicatedGateway.gateway.configName === "config-3",
  "duplicateSelectedGateway must allocate a disabled route with a fresh config identity."
);
const removedGateway = configSurfaceModule.removeSelectedGateway(duplicatedGateway.gateways, duplicatedGateway.index);
assert(
  removedGateway.removed?.id === "config-3"
    && removedGateway.gateways.length === 2
    && removedGateway.index === 1,
  "removeSelectedGateway must remove the selected route and keep a valid selected index."
);
const movedGateway = configSurfaceModule.moveSelectedGateway(removedGateway.gateways, 1, -1);
assert(
  movedGateway.moved?.id === "config-2"
    && movedGateway.index === 0
    && movedGateway.gateways[0]?.id === "config-2",
  "moveSelectedGateway must move the selected route and return the new index."
);
const variableAdded = configSurfaceModule.addRouteVariable(movedGateway.gateways, 0);
assert(
  variableAdded.key === "Variable1"
    && configSurfaceModule.routeVariableRowsFor(variableAdded.gateways[0]).length === 1,
  "addRouteVariable must add a default route variable."
);
const variableChanged = configSurfaceModule.setRouteVariable(variableAdded.gateways, 0, "Variable1", "PlayerName", "Rabi");
assert(
  configSurfaceModule.routeVariableRowsFor(variableChanged[0]).some((row) => row.key === "PlayerName" && row.value === "Rabi"),
  "setRouteVariable must rename and update a route variable."
);
const variableRemoved = configSurfaceModule.removeRouteVariable(variableChanged, 0, "PlayerName");
assert(
  configSurfaceModule.routeVariableRowsFor(variableRemoved[0]).length === 0,
  "removeRouteVariable must remove a route variable."
);
const ruleAdded = configSurfaceModule.addNotificationRule(variableRemoved, 0);
assert(
  ruleAdded.rule.id.startsWith("rule-aiui-")
    && configSurfaceModule.notificationRuleRowsFor(ruleAdded.gateways[0]).length === 1,
  "addNotificationRule must add an AIUI-owned notification rule draft."
);
const ruleChanged = configSurfaceModule.setNotificationRule(ruleAdded.gateways, 0, ruleAdded.index, {
  name: "AIUI 语音规则",
  routeKinds: "voice_transcript, rabilink",
  regex: "需求|报错",
  template: "请处理：{message}"
});
const changedRule = configSurfaceModule.notificationRuleRowsFor(ruleChanged[0])[0];
assert(
  changedRule.name === "AIUI 语音规则"
    && changedRule.routeKinds.includes("voice_transcript")
    && changedRule.routeKinds.includes("rabilink")
    && changedRule.template.includes("{message}"),
  "setNotificationRule must update rule fields and parse routeKinds."
);
const scheduleAdded = configSurfaceModule.addNotificationSchedule(ruleChanged, 0, 0);
assert(
  scheduleAdded.schedule.id.startsWith("schedule-aiui-")
    && configSurfaceModule.notificationScheduleRowsFor(scheduleAdded.gateways[0], 0).length === 1,
  "addNotificationSchedule must add an AIUI-owned schedule draft to the selected rule."
);
const scheduleChanged = configSurfaceModule.setNotificationSchedule(scheduleAdded.gateways, 0, 0, scheduleAdded.index, {
  name: "每日巡检",
  type: "daily_time",
  timeOfDay: "09:30"
});
const changedSchedule = configSurfaceModule.notificationScheduleRowsFor(scheduleChanged[0], 0)[0];
assert(
  changedSchedule.name === "每日巡检"
    && changedSchedule.type === "daily_time"
    && changedSchedule.timeOfDay === "09:30"
    && changedSchedule.intervalSeconds === undefined,
  "setNotificationSchedule must normalize schedule fields for the selected type."
);
const scheduleRemoved = configSurfaceModule.removeNotificationSchedule(scheduleChanged, 0, 0, 0);
assert(
  configSurfaceModule.notificationScheduleRowsFor(scheduleRemoved[0], 0).length === 0,
  "removeNotificationSchedule must remove a schedule from the selected rule."
);
const ruleRemoved = configSurfaceModule.removeNotificationRule(scheduleRemoved, 0, 0);
assert(
  configSurfaceModule.notificationRuleRowsFor(ruleRemoved[0]).length === 0,
  "removeNotificationRule must remove a notification rule."
);
const policyRows = configSurfaceModule.messageAdapterPolicyRowsFor(ruleRemoved[0]);
assert(
  policyRows.length === 1
    && policyRows[0].id === "napcat"
    && policyRows[0].inputEnabled === true
    && policyRows[0].supportedOutputs.includes("text"),
  "messageAdapterPolicyRowsFor must expose configured adapter policies."
);
const policyChanged = configSurfaceModule.setMessageAdapterPolicy(ruleRemoved, 0, "napcat", {
  inputEnabled: false,
  outputEnabled: false,
  supportedOutputs: "text, voice"
});
const napcatPolicy = configSurfaceModule.messageAdapterPolicyRowsFor(policyChanged[0])[0];
assert(
  napcatPolicy.inputEnabled === false
    && napcatPolicy.outputEnabled === false
    && napcatPolicy.supportedOutputs.includes("voice")
    && !napcatPolicy.supportedOutputs.includes("image")
    && policyChanged[0].messageAdaptersDisabled.includes("napcat"),
  "setMessageAdapterPolicy must update policy fields and legacy disabled adapters."
);
const payloadChanged = configSurfaceModule.toggleMessageAdapterPayload(policyChanged, 0, "napcat", "file");
assert(
  configSurfaceModule.messageAdapterPolicyRowsFor(payloadChanged[0])[0].supportedOutputs.includes("file"),
  "toggleMessageAdapterPayload must toggle a supported output kind."
);
const napcatAdded = configSurfaceModule.addNapcatInstance(payloadChanged, 0);
assert(
  napcatAdded.instance.id === "napcat-2"
    && configSurfaceModule.napcatInstanceRowsFor(napcatAdded.gateways[0]).length === 2,
  "addNapcatInstance must add a default NapCat instance draft."
);
const napcatChanged = configSurfaceModule.setNapcatInstance(napcatAdded.gateways, 0, napcatAdded.index, {
  id: "qq-main",
  name: "主 QQ",
  enabled: true,
  gatewayPort: "8899",
  httpUrl: "http://127.0.0.1:3100/",
  webuiUrl: "http://127.0.0.1:6199/webui/",
  accessToken: "test-access",
  webuiToken: "test-webui",
  botUserId: "10001",
  botNickname: "Rabi"
});
const changedNapcat = configSurfaceModule.napcatInstanceRowsFor(napcatChanged[0])[1];
assert(
  changedNapcat.id === "qq-main"
    && changedNapcat.gatewayPort === 8899
    && changedNapcat.httpUrl === "http://127.0.0.1:3100"
    && changedNapcat.webuiUrl === "http://127.0.0.1:6199/webui",
  "setNapcatInstance must normalize NapCat instance fields."
);
const napcatRemoved = configSurfaceModule.removeNapcatInstance(napcatChanged, 0, 1);
assert(
  configSurfaceModule.napcatInstanceRowsFor(napcatRemoved[0]).length === 1,
  "removeNapcatInstance must remove a NapCat instance draft."
);
const pipelineChanged = configSurfaceModule.setPipelineConfig(napcatRemoved, 0, {
  id: "voice_chat",
  name: "Voice chat",
  inputAdapter: "webhook",
  outputAdapter: "fennenote",
  outputPipeline: "fennenote",
  promptOutputMode: "voice_short",
  ttsProvider: "oumuq",
  ttsVoice: "cloud_zh_voice",
  ttsPlay: true,
  preventFeedbackLoop: true,
  replyToSource: false
});
const pipelineConfig = configSurfaceModule.pipelineConfigFor(pipelineChanged[0]);
assert(
  pipelineConfig.outputAdapter === "fennenote"
    && pipelineConfig.promptOutputMode === "voice_short"
    && pipelineConfig.ttsPlay === true
    && configSurfaceModule.pipelineSummaryFor(pipelineChanged[0]).includes("oumuq"),
  "setPipelineConfig must update GatewayDefinition.pipeline fields for AIUI."
);
const pipelineCleared = configSurfaceModule.clearPipelineConfig(pipelineChanged, 0);
assert(
  pipelineCleared[0].pipeline === undefined
    && configSurfaceModule.pipelineSummaryFor(pipelineCleared[0]).includes("未配置"),
  "clearPipelineConfig must remove GatewayDefinition.pipeline overrides."
);
const profileAdded = configSurfaceModule.addRouteProfile(pipelineCleared, 0);
assert(
  profileAdded.profile.id === "profile-2"
    && configSurfaceModule.routeProfileRowsFor(profileAdded.gateways[0]).length === 2,
  "addRouteProfile must add a default Route Profile draft."
);
const profileChanged = configSurfaceModule.setRouteProfile(profileAdded.gateways, 0, profileAdded.index, {
  id: "profile-main",
  name: "主 Profile",
  enabled: false,
  agentRoleId: "Rabi",
  agentRoleFile: "persona.md",
  pipelinePreset: "voice_chat",
  recentMessageLimit: "12",
  routeVariables: "{ \"Scene\": \"AIUI\" }"
});
const changedProfile = configSurfaceModule.routeProfileRowsFor(profileChanged[0])[1];
assert(
  changedProfile.id === "profile-main"
    && changedProfile.enabled === false
    && changedProfile.recentMessageLimit === 12
    && changedProfile.routeVariables.Scene === "AIUI"
    && profileChanged[0].roleRouteNames.Rabi === "主 Profile",
  "setRouteProfile must update profile fields and legacy role maps."
);
const profileRemoved = configSurfaceModule.removeRouteProfile(profileChanged, 0, 1);
assert(
  configSurfaceModule.routeProfileRowsFor(profileRemoved[0]).length === 1,
  "removeRouteProfile must remove a Route Profile draft."
);
const templateChanged = configSurfaceModule.setNotificationTemplate(profileRemoved, 0, 0, "群消息：{message}");
assert(
  templateChanged[0].groupNotificationTemplate === "群消息：{message}"
    && configSurfaceModule.notificationTemplateSummaryFor(templateChanged[0], 0).includes("群消息"),
  "setNotificationTemplate must update the selected notification template field."
);
const templateCleared = configSurfaceModule.clearNotificationTemplate(templateChanged, 0, 0);
assert(
  templateCleared[0].groupNotificationTemplate === undefined
    && configSurfaceModule.notificationTemplateValueFor(templateCleared[0], 0) === "",
  "clearNotificationTemplate must remove the selected notification template field."
);

function webguiCalls(source) {
  return [...source.matchAll(/(getMobileWebgui|postMobileWebgui)\([\s\S]*?,\s*"(\/[^"]*)"([\s\S]*?)\);/g)]
    .map((match) => ({
      helper: match[1],
      path: match[2],
      method: match[1] === "getMobileWebgui" ? "GET" : match[3].includes('"PATCH"') ? "PATCH" : "POST"
    }));
}

function relayAllowsWebguiPath(source, call) {
  return source.includes(`upperMethod === "${call.method}"`)
    && source.includes(`pathname === "${call.path}"`);
}

const rabilinkApi = read(files.rabilinkApi);
const relayServer = read(files.relayServer);
assert(
  rabilinkApi.includes("/api/rabilink/mobile/webgui")
    && relayServer.includes('url.pathname === "/api/rabilink/mobile/webgui"'),
  "Relay/mobile API contract is missing /api/rabilink/mobile/webgui."
);
for (const endpoint of [
  "/api/rabilink/mobile/state",
  "/api/rabilink/mobile/target",
  "/api/rabilink/mobile/routes"
]) {
  assert(
    rabilinkApi.includes(endpoint) && relayServer.includes(endpoint),
    `Relay/mobile API contract is missing ${endpoint}.`
  );
}

const calls = webguiCalls(pageInk);
assert(calls.length > 0, "AIUI page must call at least one mobile WebGUI endpoint.");
const missingWebguiPaths = calls
  .filter((call) => !relayAllowsWebguiPath(relayServer, call))
  .map((call) => `${call.method} ${call.path}`);
assert(
  missingWebguiPaths.length === 0,
  `Relay mobile WebGUI whitelist does not cover AIUI calls: ${missingWebguiPaths.join(", ")}`
);

for (const path of [
  "/reload",
  "/manager/shutdown",
  "/open-config-file",
  "/api/message/napcat-add",
  "/api/message/napcat-launch",
  "/api/message/napcat-restart",
  "/api/message/napcat-remove",
  "/api/agent/copilot-install",
  "/api/agent/copilot-login",
  "/api/agent/marvis-open",
  "/api/deploy-astrbot-adapter",
  "/api/remote-agent/scan",
  "/api/remote-agent/connect",
  "/api/remote-agent/disconnect"
]) {
  assert(pageInk.includes(`"${path}"`), `AIUI tool surface must declare ${path}.`);
  assert(
    relayAllowsWebguiPath(relayServer, { method: "POST", path }),
    `Relay mobile WebGUI whitelist must allow POST ${path}.`
  );
}

for (const path of [
  "/api/agent/copilot-status",
  "/api/remote-agent/devices"
]) {
  assert(pageInk.includes(`"${path}"`), `AIUI tool surface must declare ${path}.`);
  assert(
    relayAllowsWebguiPath(relayServer, { method: "GET", path }),
    `Relay mobile WebGUI whitelist must allow GET ${path}.`
  );
}

for (const action of ["start", "stop", "restart", "delete", "manual-trigger"]) {
  assert(
    pageInk.includes(`gatewayActionPath("${action}")`) || pageInk.includes(`controlGateway("${action}")`),
    `AIUI page does not expose route runtime action: ${action}.`
  );
}
assert(
  relayServer.includes("\\/gateways\\/[^/]+\\/") && relayServer.includes("manual-trigger") && relayServer.includes("delete"),
  "Relay mobile WebGUI whitelist must allow route runtime actions."
);
assert(
  pageInk.includes("startManager") && relayServer.includes('pathname === "/manager/start"'),
  "AIUI and Relay must expose PC WebGUI manager start."
);
assert(
  pageInk.includes("configureNapcatOnebot") && pageInk.includes('"/api/message/napcat-configure-onebot"'),
  "AIUI page must expose PC WebGUI NapCat OneBot configuration."
);
assert(
  pageInk.includes("repairAllNapcatIssues") && pageInk.includes('"/api/message/napcat-repair-all"'),
  "AIUI page must expose PC WebGUI NapCat repair-all."
);
assert(
  pageInk.includes("title: \"配置 NapCat\"") && pageInk.includes("title: \"修复 NapCat\""),
  "AIUI NapCat repair actions must be guarded by confirmation dialogs."
);
assert(
  pageInk.includes("removeGatewayDraft") && pageInk.includes("wx.showModal"),
  "AIUI route removal must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("moveGatewayUp") && pageInk.includes("moveGatewayDown"),
  "AIUI page must expose route ordering controls."
);
assert(
  pageInk.includes("applyRouteVariableDraft"),
  "AIUI assistant backend must retain route variable actions."
);
assert(
  pageInk.includes("applyNotificationRuleDraft"),
  "AIUI assistant backend must retain notification rule actions."
);
assert(
  pageInk.includes("applyNotificationScheduleDraft"),
  "AIUI assistant backend must retain notification schedule actions."
);
assert(
  pageInk.includes("applyNotificationTemplateDraft"),
  "AIUI assistant backend must retain notification template actions."
);
assert(
  pageInk.includes("applyIntegrationDraft"),
  "AIUI assistant backend must retain message integration actions."
);
for (const fieldName of [
  "webhookPath",
  "fenneNoteWebhookPath",
  "xiaoaiWebhookPath",
  "rabiLinkWebhookPath",
  "heartbeatIntervalSeconds",
  "heartbeatMessage",
  "wecomBotId",
  "wecomWsUrl",
  "remoteAgentDefaultDeviceId"
]) {
  assert(pageInk.includes(fieldName), `AIUI integration panel must write ${fieldName}.`);
}
assert(
  pageInk.includes("clearNotificationTemplateDraft") && pageInk.includes("title: \"清空模板\""),
  "AIUI notification template clearing must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("applyMessagePolicyDraft"),
  "AIUI assistant backend must retain message adapter policy actions."
);
assert(
  pageInk.includes("applyNapcatInstanceDraft"),
  "AIUI assistant backend must retain NapCat instance actions."
);
assert(
  pageInk.includes("removeNapcatInstanceDraft") && pageInk.includes("title: \"移除 NapCat\""),
  "AIUI NapCat instance removal must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("applyPipelineDraft"),
  "AIUI assistant backend must retain pipeline override actions."
);
assert(
  pageInk.includes("applyRouteProfileDraft"),
  "AIUI assistant backend must retain Route Profile actions."
);
assert(
  pageInk.includes("removeRouteProfileDraft") && pageInk.includes("title: \"移除 Profile\""),
  "AIUI Route Profile removal must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("clearPipelineDraft") && pageInk.includes("title: \"清空管道\""),
  "AIUI pipeline clearing must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("removeNotificationScheduleDraft") && pageInk.includes("title: \"移除计划\""),
  "AIUI notification schedule removal must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("removeNotificationRuleDraft") && pageInk.includes("title: \"移除规则\""),
  "AIUI notification rule removal must be guarded by a confirmation dialog."
);
assert(
  pageInk.includes("var(--app-width, 480px)") && pageInk.includes("var(--rabilink-surface-height, 352px)"),
  "AIUI page must separate the 480px theme width from the 352px RabiLink surface height."
);
assert(
  pageInk.includes("var(--color-background, #000000)") && pageInk.includes("var(--color-primary, #40ff5e)"),
  "AIUI page must use the green HUD token baseline."
);
assert(
  !/#d24b5c|#f4f8ff|#101722|#0c1118|#8ea0b7/i.test(pageInk),
  "AIUI page must not keep the old multicolor phone-style palette."
);

console.log("RabiLink AIUI checks passed.");

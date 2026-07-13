import fs from "node:fs";
import path from "node:path";
import {
  GATEWAY_JSON_FIELDS,
  GATEWAY_SCALAR_FIELDS
} from "../utils/config-surface.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");

const files = {
  quickSetup: path.join(repoRoot, "ribiwebgui", "src", "components", "QuickSetupDialog.vue"),
  routeConfig: path.join(repoRoot, "ribiwebgui", "src", "pages", "RouteConfigPage.vue"),
  gatewayConfigModel: path.join(repoRoot, "src", "shared", "gatewayConfigModel.ts"),
  aiuiPage: path.join(projectRoot, "pages", "home", "index.ink"),
  configSurface: path.join(projectRoot, "utils", "config-surface.js")
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasAny(source, needles) {
  return needles.some((needle) => source.includes(needle));
}

function assertHas(source, needles, label, side) {
  assert(
    hasAny(source, needles),
    `${side} is missing ${label}; expected one of: ${needles.join(", ")}`
  );
}

function assertFieldCoverage(field) {
  const webguiNeedles = field.webgui || [field.key];
  const aiuiNeedles = field.aiui || [field.key];
  if (!field.aiuiOnly) assertHas(webguiSource, webguiNeedles, field.key, "RibiWebGUI");
  assertHas(aiuiSource, aiuiNeedles, field.key, "RabiLink AIUI");
}

function extractTypeBody(source, typeName) {
  const match = source.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)^\\};`, "m"));
  assert(match, `Shared config model is missing type ${typeName}.`);
  return match[1];
}

function extractTypeFields(source, typeName) {
  return [...extractTypeBody(source, typeName).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)]
    .map((match) => match[1]);
}

function assertSharedTypeCoveredByFields(typeName, fields, fieldSet, label) {
  const missing = fields.filter((field) => !fieldSet.has(field));
  assert(
    missing.length === 0,
    `${label} does not expose every ${typeName} field: ${missing.join(", ")}`
  );
}

const quickSetupSource = read(files.quickSetup);
const routeConfigSource = read(files.routeConfig);
const webguiSource = `${quickSetupSource}\n${routeConfigSource}`;
const sharedConfigSource = read(files.gatewayConfigModel);
const aiuiPageSource = read(files.aiuiPage);
const configSurfaceSource = read(files.configSurface);
const aiuiSource = `${aiuiPageSource}\n${configSurfaceSource}`;
const sharedGatewayFields = extractTypeFields(sharedConfigSource, "GatewayDefinition");
const aiuiGatewayFieldSet = new Set([
  ...GATEWAY_SCALAR_FIELDS.map((field) => field.key),
  ...GATEWAY_JSON_FIELDS.map((field) => field.key)
]);

assertSharedTypeCoveredByFields(
  "GatewayDefinition",
  sharedGatewayFields,
  aiuiGatewayFieldSet,
  "RabiLink AIUI advanced/json config surface"
);

const gatewayFields = [
  { key: "enabled" },
  { key: "configName" },
  { key: "messageAdapters", webgui: ["form.adapters", "gateway.messageAdapters"], aiui: ["messageAdaptersFor", "setMessageAdapter"] },
  { key: "agentAdapters", webgui: ["form.agentAdapters", "gateway.agentAdapters"], aiui: ["agentAdaptersFor", "setAgentAdapter"] },
  { key: "agentRoleId" },
  { key: "agentModel" },
  { key: "codexThreadName" },
  { key: "codexCwd" },
  { key: "copilotCliBin" },
  { key: "copilotCwd" },
  { key: "marvisAppId" },
  { key: "astrbotUrl" },
  { key: "astrbotUsername" },
  { key: "astrbotPassword" },
  { key: "astrbotProjectId" },
  { key: "astrbotSessionId" },
  { key: "gatewayPort" },
  { key: "napcatHttpUrl" },
  { key: "napcatWebuiUrl" },
  { key: "napcatAccessToken" },
  { key: "napcatWebuiToken" },
  { key: "heartbeatIntervalSeconds" },
  { key: "heartbeatMessage" },
  { key: "webhookPort" },
  { key: "webhookPath" },
  { key: "fenneNoteWebhookPort" },
  { key: "fenneNoteWebhookPath" },
  { key: "xiaoaiWebhookPort" },
  { key: "xiaoaiWebhookPath" },
  { key: "rabiLinkWebhookPort" },
  { key: "rabiLinkWebhookPath" },
  { key: "rabiLinkWebhookHost" },
  { key: "wecomBotId" },
  { key: "wecomBotSecret" },
  { key: "wecomWsUrl" },
  { key: "remoteAgentDefaultDeviceId" },
  { key: "remoteAgentDefaultCwd" },
  { key: "remoteAgentDefaultThreadName" },
  { key: "messageAdapterPolicies", aiui: ["messageAdapterPolicyRowsFor", "setMessageAdapterPolicy"] },
  { key: "napcatInstances", aiui: ["napcatInstanceRowsFor", "setNapcatInstance"] },
  { key: "pipeline", aiuiOnly: true, aiui: ["pipelineConfigFor", "setPipelineConfig"] },
  { key: "routeProfiles", aiuiOnly: true, aiui: ["routeProfileRowsFor", "setRouteProfile"] },
  { key: "routeVariables", aiuiOnly: true, aiui: ["routeVariableRowsFor", "setRouteVariable"] },
  { key: "notificationRules", aiuiOnly: true, aiui: ["notificationRuleRowsFor", "setNotificationRule"] }
];

const napcatInstanceFields = [
  ["id", "napcatInstanceId"],
  ["name", "napcatInstanceName"],
  ["enabled", "napcatInstanceEnabled"],
  ["gatewayPort", "napcatGatewayPort"],
  ["httpUrl", "napcatHttpUrl"],
  ["webuiUrl", "napcatWebuiUrl"],
  ["accessToken", "napcatAccessToken"],
  ["webuiToken", "napcatWebuiToken"],
  ["launchCommand", "napcatLaunchCommand"],
  ["workingDir", "napcatWorkingDir"],
  ["botUserId", "napcatBotUserId"],
  ["botNickname", "napcatBotNickname"]
].map(([key, aiuiState]) => ({
  key: `napcatInstances.${key}`,
  webgui: [`.${key}`, `${key}:`, `instance.${key}`],
  aiui: [aiuiState, `${key}: this.data.${aiuiState}`]
}));

const pipelineFields = [
  ["id", "pipelineId"],
  ["name", "pipelineName"],
  ["inputAdapter", "pipelineInputAdapter"],
  ["outputAdapter", "pipelineOutputAdapter"],
  ["outputPipeline", "pipelineOutputPipeline"],
  ["promptOutputMode", "pipelinePromptOutputMode"],
  ["ttsProvider", "pipelineTtsProvider"],
  ["ttsVoice", "pipelineTtsVoice"],
  ["ttsWorkerUrl", "pipelineTtsWorkerUrl"],
  ["ttsPlay", "pipelineTtsPlay"],
  ["preventFeedbackLoop", "pipelinePreventFeedbackLoop"],
  ["replyToSource", "pipelineReplyToSource"]
].map(([key, aiuiState]) => ({
  aiuiOnly: true,
  key: `pipeline.${key}`,
  webgui: [`.${key}`, `${key}:`, `pipeline.${key}`],
  aiui: [aiuiState, `${key}: this.data.${aiuiState}`]
}));

const routeProfileFields = [
  ["id", "routeProfileId"],
  ["name", "routeProfileName"],
  ["enabled", "routeProfileEnabled"],
  ["agentRoleId", "routeProfileRoleId"],
  ["agentRoleFile", "routeProfileRoleFile"],
  ["rolesDir", "routeProfileRolesDir"],
  ["dataDir", "routeProfileDataDir"],
  ["recentMessageLimit", "routeProfileRecentMessageLimit"],
  ["pipelinePreset", "routeProfilePipelinePreset"],
  ["pipeline", "routeProfilePipelineJson"],
  ["routeVariables", "routeProfileVariablesJson"],
  ["notificationRules", "notificationRules"]
].map(([key, aiuiState]) => ({
  aiuiOnly: true,
  key: `routeProfiles.${key}`,
  webgui: [`.${key}`, `${key}:`, `profile.${key}`],
  aiui: [aiuiState, `${key}: this.data.${aiuiState}`]
}));

const notificationRuleFields = [
  ["id", "notificationRuleSummary"],
  ["name", "notificationRuleName"],
  ["enabled", "notificationRuleEnabled"],
  ["routeKinds", "notificationRuleRouteKinds"],
  ["targetGroupId", "notificationRuleTargetGroupId"],
  ["allowedSpeakerNames", "notificationRuleAllowedSpeakerNames"],
  ["regex", "notificationRuleRegex"],
  ["template", "notificationRuleTemplate"],
  ["schedules", "notificationScheduleRows"]
].map(([key, aiuiState]) => ({
  aiuiOnly: true,
  key: `notificationRules.${key}`,
  webgui: [`.${key}`, `${key}:`, `rule.${key}`],
  aiui: [aiuiState, `${key}: this.data.${aiuiState}`]
}));

const notificationScheduleFields = [
  ["id", "notificationScheduleSummary"],
  ["name", "notificationScheduleName"],
  ["enabled", "notificationScheduleEnabled"],
  ["type", "notificationScheduleType"],
  ["intervalSeconds", "notificationScheduleIntervalSeconds"],
  ["windowStartTime", "notificationScheduleWindowStartTime"],
  ["windowEndTime", "notificationScheduleWindowEndTime"],
  ["timeOfDay", "notificationScheduleTimeOfDay"],
  ["onceAt", "notificationScheduleOnceAt"]
].map(([key, aiuiState]) => ({
  aiuiOnly: true,
  key: `notificationRules.schedules.${key}`,
  webgui: [`.${key}`, `${key}:`, `schedule.${key}`],
  aiui: [aiuiState, `${key}: this.data.${aiuiState}`]
}));

for (const field of [
  ...gatewayFields,
  ...napcatInstanceFields,
  ...pipelineFields,
  ...routeProfileFields,
  ...notificationRuleFields,
  ...notificationScheduleFields
]) {
  assertFieldCoverage(field);
}

const requiredPanels = [
  "route",
  "runtime",
  "message",
  "policy",
  "napcat",
  "agent",
  "persona",
  "pipeline",
  "profiles",
  "variables",
  "rules",
  "schedule",
  "templates",
  "integrations",
  "ports",
  "relay",
  "tools",
  "advanced",
  "json"
];

for (const panelId of requiredPanels) {
  assert(
    configSurfaceSource.includes(`id: "${panelId}"`),
    `AIUI assistant backend is missing configuration topic ${panelId}.`
  );
}
assert(aiuiPageSource.includes('class="unifiedModeHud {{modeFrameRelayout'), "AIUI must expose the conversational configuration assistant through the shared mode HUD.");
assert(aiuiPageSource.includes("assistantUserText") && aiuiPageSource.includes("assistantReplyText"), "The shared mode HUD must retain the assistant conversation fields.");
assert(!aiuiPageSource.includes('class="legacyConfigurationModeHost'), "AIUI must not ship the old manual configuration dashboard markup.");

const structuredEditors = [
  { label: "message adapter policy", panel: "policy", apply: "applyMessagePolicyDraft", helpers: ["messageAdapterPolicyRowsFor", "setMessageAdapterPolicy"] },
  { label: "NapCat instances", panel: "napcat", apply: "applyNapcatInstanceDraft", helpers: ["napcatInstanceRowsFor", "setNapcatInstance"] },
  { label: "pipeline override", panel: "pipeline", apply: "applyPipelineDraft", helpers: ["pipelineConfigFor", "setPipelineConfig"] },
  { label: "Route Profile", panel: "profiles", apply: "applyRouteProfileDraft", helpers: ["routeProfileRowsFor", "setRouteProfile"] },
  { label: "route variables", panel: "variables", apply: "applyRouteVariableDraft", helpers: ["routeVariableRowsFor", "setRouteVariable"] },
  { label: "notification rules", panel: "rules", apply: "applyNotificationRuleDraft", helpers: ["notificationRuleRowsFor", "setNotificationRule"] },
  { label: "notification schedules", panel: "schedule", apply: "applyNotificationScheduleDraft", helpers: ["notificationScheduleRowsFor", "setNotificationSchedule"] },
  { label: "notification templates", panel: "templates", apply: "applyNotificationTemplateDraft", helpers: ["NOTIFICATION_TEMPLATE_FIELDS", "setNotificationTemplate"] },
  { label: "integrations", panel: "integrations", apply: "applyIntegrationDraft", helpers: ["remoteAgentDefaultDeviceId", "wecomBotId", "heartbeatIntervalSeconds"] }
];

for (const editor of structuredEditors) {
  assert(aiuiPageSource.includes(editor.apply), `AIUI assistant backend is missing ${editor.label} apply action ${editor.apply}.`);
  for (const helper of editor.helpers) {
    assert(aiuiSource.includes(helper), `AIUI is missing ${editor.label} helper/field ${helper}.`);
  }
}

const runtimeAndRiskActions = [
  { label: "start route", aiui: ["controlGateway(\"start\")"], relayPath: "/gateways/" },
  { label: "stop route", aiui: ["controlGateway(\"stop\")"], relayPath: "/gateways/" },
  { label: "restart route", aiui: ["controlGateway(\"restart\")"], relayPath: "/gateways/" },
  { label: "manual trigger", aiui: ["controlGateway(\"manual-trigger\")", "gatewayActionPath(\"manual-trigger\")"], relayPath: "/gateways/" },
  { label: "delete route", aiui: ["controlGateway(\"delete\")", "gatewayActionPath(\"delete\")", "removeGatewayDraft"], relayPath: "/gateways/" },
  { label: "save config", aiui: ["saveWebguiConfig"], relayPath: "/gateways" },
  { label: "reload manager", aiui: ["reloadPcWebgui", "WEBGUI_TOOL_PATHS.reload"], relayPath: "/reload" },
  { label: "shutdown manager", aiui: ["shutdownManager", "WEBGUI_TOOL_PATHS.managerShutdown"], relayPath: "/manager/shutdown" },
  { label: "open config file", aiui: ["openPcConfigFile"], relayPath: "/open-config-file" },
  { label: "NapCat repair", aiui: ["configureNapcatOnebot", "repairAllNapcatIssues"], relayPath: "/api/message/napcat-repair-all" },
  { label: "remote agent connect", aiui: ["connectRemoteAgentDevice"], relayPath: "/api/remote-agent/connect" }
];

for (const action of runtimeAndRiskActions) {
  assertHas(aiuiPageSource, action.aiui, action.label, "RabiLink AIUI");
  assert(webguiSource.includes(action.relayPath) || aiuiPageSource.includes(action.relayPath), `WebGUI/AIUI is missing action path for ${action.label}.`);
}

for (const modalTitle of [
  "配置 NapCat",
  "修复 NapCat",
  "移除 NapCat",
  "清空管道",
  "移除 Profile",
  "移除规则",
  "移除计划",
  "清空模板"
]) {
  assert(
    aiuiPageSource.includes(`title: "${modalTitle}"`) && aiuiPageSource.includes("wx.showModal"),
    `Risky AIUI action must be guarded by wx.showModal: ${modalTitle}.`
  );
}

console.log(
  `RabiLink AIUI WebGUI assistant backend audit passed (${sharedGatewayFields.length} shared gateway fields, ${gatewayFields.length} direct fields, ${structuredEditors.length} structured action groups).`
);

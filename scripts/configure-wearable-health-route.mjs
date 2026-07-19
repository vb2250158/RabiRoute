import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeRoot = path.join(rootDir, "data", "route");
const roleRoot = path.join(rootDir, "data", "roles", "YeYu");
const sourcePath = path.join(routeRoot, "夜雨", "adapterConfig.json");
const targetDir = path.join(routeRoot, "夜雨健康");
const targetPath = path.join(targetDir, "adapterConfig.json");
const personaPath = path.join(roleRoot, "personaConfig.json");
const execute = process.argv.includes("--execute");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
  fs.renameSync(tempPath, filePath);
}

function usedPorts() {
  const ports = new Set([8790]);
  if (!fs.existsSync(routeRoot)) return ports;
  for (const entry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(routeRoot, entry.name, "adapterConfig.json");
    if (!fs.existsSync(configPath)) continue;
    const config = readJson(configPath);
    for (const [key, value] of Object.entries(config)) {
      if (/port$/i.test(key) && Number.isInteger(Number(value))) ports.add(Number(value));
    }
  }
  return ports;
}

function nextUnusedPort() {
  const used = usedPorts();
  let candidate = 8894;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

if (!fs.existsSync(sourcePath)) {
  throw new Error("Night Rain route config is unavailable; refusing to invent an Agent binding.");
}
if (!fs.existsSync(personaPath)) {
  throw new Error("YeYu personaConfig.json is unavailable.");
}

const source = readJson(sourcePath);
const persona = readJson(personaPath);
const notificationRules = Array.isArray(persona.notificationRules) ? [...persona.notificationRules] : [];
const ruleId = "wearable-health-alert-agent";
const rule = {
  id: ruleId,
  name: "智能手表/手环健康告警交给夜雨",
  enabled: true,
  routeKinds: ["wearable_health_alert"],
  targetGroupId: "",
  allowedSpeakerNames: [],
  regex: "",
  template: ""
};
const existingRuleIndex = notificationRules.findIndex((item) => item?.id === ruleId);
if (existingRuleIndex >= 0) notificationRules[existingRuleIndex] = rule;
else notificationRules.push(rule);

const target = {
  configName: "夜雨健康",
  name: "智能手表/手环健康消息端",
  routeName: "夜雨 健康消息端",
  enabled: true,
  messageAdapters: ["wearable"],
  messageAdaptersDisabled: [],
  messageInputsDisabled: false,
  messageAdapterPolicies: {
    wearable: {
      inputEnabled: true,
      outputEnabled: false,
      supportedOutputs: ["text"]
    }
  },
  pipelinePreset: typeof source.pipelinePreset === "string" ? source.pipelinePreset : undefined,
  gatewayPort: nextUnusedPort(),
  agentModel: typeof source.agentModel === "string" ? source.agentModel : "",
  codexThreadName: typeof source.codexThreadName === "string" ? source.codexThreadName : undefined,
  codexCwd: typeof source.codexCwd === "string" ? source.codexCwd : "..",
  rolesDir: typeof source.rolesDir === "string" ? source.rolesDir : "data/roles",
  agentRoleId: "YeYu",
  agentRoleFile: typeof source.agentRoleFile === "string" ? source.agentRoleFile : "persona.md",
  agentAdapters: ["codex"]
};

if (!execute) {
  console.log(JSON.stringify({
    mode: "dry-run",
    routeWillBeCreated: !fs.existsSync(targetPath),
    personaRuleWillBeCreated: existingRuleIndex < 0,
    copiedSecretFields: 0
  }));
  process.exit(0);
}

const backupDir = path.join(rootDir, "data", "wearable-health-route-backups", timestamp());
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(personaPath, path.join(backupDir, "personaConfig.json"));
if (fs.existsSync(targetPath)) {
  fs.copyFileSync(targetPath, path.join(backupDir, "adapterConfig.json"));
}

writeJsonAtomic(targetPath, target);
writeJsonAtomic(personaPath, { ...persona, notificationRules });

console.log(JSON.stringify({
  mode: "executed",
  routeConfigured: true,
  personaRuleConfigured: true,
  copiedSecretFields: 0,
  backupCreated: true
}));

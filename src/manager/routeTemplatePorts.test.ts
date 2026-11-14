import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ManagerConfigRepository } from "./configRepository.js";
import { autoAssignGatewayPorts, collectGatewayPortClaims, normalizeGatewayDefinition } from "../shared/gatewayConfigModel.js";
import { resolvePipeline } from "../pipelines.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const templateRoot = path.join(projectRoot, "examples/data/route");
const names = ["main", "RabiLink", "xiaoai", "voice-chat", "rokid-native-voice", "weixin", "wecom"];
const listenerFields = ["gatewayPort", "webhookPort", "xiaoaiWebhookPort", "rabiLinkWebhookPort"] as const;

for (const asynchronous of [false, true]) test(`first-start ${asynchronous ? "async" : "sync"} seed retains automatic listener requests through the real repository`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-template-port-test-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "examples/data"), { recursive: true });
  fs.cpSync(templateRoot, path.join(root, "examples/data/route"), { recursive: true });
  const repository = new ManagerConfigRepository({ rootDir: root, managerPort: 31000 });
  if (asynchronous) await repository.ensureDataDirsAsync(); else repository.ensureDataDirs();
  const loaded = repository.readConfig();
  assert.equal(loaded.gateways.length, names.length);
  for (const name of names) {
    const copied = JSON.parse(fs.readFileSync(repository.adapterConfigPath(name), "utf8"));
    for (const field of listenerFields) if (Object.hasOwn(copied, field)) assert.equal(copied[field], 0, `${name}.${field}`);
    assert.equal(copied.enabled, name === "main");
    const gateway = loaded.gateways.find(route => route.configName === name);
    assert.ok(gateway, name);
    const active = normalizeGatewayDefinition({ ...gateway, enabled: true });
    autoAssignGatewayPorts([active], 31000);
    for (const field of listenerFields) if (Object.hasOwn(copied, field)) assert.equal(active[field], 0, `${name}.${field} after allocation`);
    assert.equal(collectGatewayPortClaims([active]).filter(claim => claim.kind !== "napcat-http").length, 0, name);
    assert.equal("fenneNoteWebhookPort" in active, false, "retired FenneNote fields never become listeners");
  }
  const main = loaded.gateways.find(route => route.configName === "main")!;
  assert.equal(main.napcatHttpUrl, "http://127.0.0.1:3000", "explicit external NapCat HTTP example remains unchanged");
  const weixin = loaded.gateways.find(route => route.configName === "weixin")!;
  assert.equal(weixin.weixinBaseUrl, "https://ilinkai.weixin.qq.com", "vendor endpoint is not a Rabi listener");
  const voice = loaded.gateways.find(route => route.configName === "voice-chat")!;
  assert.equal(resolvePipeline(voice.pipelinePreset, voice.pipeline).ttsWorkerUrl, "", "managed Speech resolves its original current owner instead of a guessed8781 URL");
  assert.equal(resolvePipeline("voice_chat", { ttsWorkerUrl: "https://speech.example.test/custom" }).ttsWorkerUrl,
    "https://speech.example.test/custom", "an explicit external speech endpoint remains supported");
});

test("seeding never rewrites an existing configured Route's explicit listener or upstream URL", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-template-existing-test-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "examples/data"), { recursive: true });
  fs.cpSync(templateRoot, path.join(root, "examples/data/route"), { recursive: true });
  const repository = new ManagerConfigRepository({ rootDir: root, managerPort: 31000 });
  const file = repository.adapterConfigPath("main");fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ gatewayPort: 43210, napcatHttpUrl: "http://192.0.2.8:44321", enabled: false });
  fs.writeFileSync(file, original);repository.ensureDataDirs();assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("XiaoAI environment defaults and explicit zero retain the same automatic request", () => {
  for (const configured of [undefined, "0", "43210"]) {
    const env = { ...process.env };for (const key of ["XIAOAI_WEBHOOK_PORT", "WEBHOOK_PORT", "GATEWAY_PORT", "DOTENV_CONFIG_PATH"]) delete env[key];
    if (configured !== undefined) env.XIAOAI_WEBHOOK_PORT = configured;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const {config}=await import('./src/config.ts');process.stdout.write(JSON.stringify(config.xiaoaiWebhookPort));"],
      { cwd: projectRoot, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);assert.equal(JSON.parse(result.stdout), configured === "43210" ? 43210 : 0);
  }
});

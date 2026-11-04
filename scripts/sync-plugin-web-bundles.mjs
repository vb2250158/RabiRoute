import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const webDist = path.join(root, "ribiwebgui", "dist");
const manifest = JSON.parse(await readFile(path.join(webDist, ".vite", "manifest.json"), "utf8"));
const entries = [
  ["src/bundles/agents/grok-bot.ts", "io.rabiroute.agent.grok-bot"],
  ["src/bundles/agents/device-agent.ts", "io.rabiroute.agent.device-agent"],
  ["src/bundles/agents/antigravity.ts", "io.rabiroute.agent.antigravity"],
  ["src/bundles/agents/workbuddy.ts", "io.rabiroute.agent.workbuddy"],
  ["src/bundles/agents/dsh.ts", "io.rabiroute.agent.dsh"],
  ["src/bundles/agents/astrbot.ts", "io.rabiroute.agent.astrbot"],
  ["src/bundles/agents/marvis.ts", "io.rabiroute.agent.marvis"],
  ["src/bundles/agents/copilot-cli.ts", "io.rabiroute.agent.copilot-cli"],
  ["src/bundles/agents/codex.ts", "io.rabiroute.agent.codex"],
  ["src/bundles/builtin/core.ts", "io.rabiroute.manager.core"],
  ["src/bundles/builtin/route-control.ts", "io.rabiroute.manager.route-control"],
  ["src/bundles/builtin/message-adapter-control.ts", "io.rabiroute.manager.message-adapter-control"],
  ["src/bundles/builtin/persona.ts", "io.rabiroute.manager.persona"],
  ["src/bundles/builtin/speech.ts", "io.rabiroute.manager.speech"],
  ["src/bundles/endpoints/speech.ts", "io.rabiroute.endpoint.speech"],
  ["src/bundles/builtin/video.ts", "io.rabiroute.manager.video"],
  ["src/bundles/builtin/performance.ts", "io.rabiroute.manager.performance"],
  ["src/bundles/builtin/diagnostics.ts", "io.rabiroute.manager.diagnostics"],
  ["src/bundles/builtin/desktop.ts", "io.rabiroute.manager.desktop"],
  ["src/bundles/builtin/xiaomi-home.ts", "io.rabiroute.manager.xiaomi-home"],
  ["src/bundles/endpoints/napcat.ts", "io.rabiroute.endpoint.napcat"],
  ["src/bundles/endpoints/heartbeat.ts", "io.rabiroute.endpoint.heartbeat"],
  ["src/bundles/endpoints/wecom.ts", "io.rabiroute.endpoint.wecom"],
  ["src/bundles/endpoints/weixin.ts", "io.rabiroute.endpoint.weixin"],
  ["src/bundles/endpoints/feishu.ts", "io.rabiroute.endpoint.feishu"],
  ["src/bundles/endpoints/webhook.ts", "io.rabiroute.endpoint.webhook"],
  ["src/bundles/endpoints/rabilink.ts", "io.rabiroute.endpoint.rabilink"]
];
for (const [source, pluginId] of entries) {
  const built = manifest[source];
  if (!built || typeof built.file !== "string" || !built.file.startsWith("assets/")) throw new Error(`Web plugin entry is missing: ${source}.`);
  const webRoot = path.join(root, "dist", "plugins", "packages", encodeURIComponent(pluginId), "1.0.0", "web");
  await rm(webRoot, { recursive: true, force: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, "client.mjs"), `export { activate } from "/${built.file}";\n`, "utf8");
}
console.log(`Wrote ${entries.length} independent Web plugin entries.`);

import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { discoverManagerBaseUrl } from "../scripts/lib/discover-manager-url.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const managerProxyPaths = [
  "/gateways",
  "/network-options",
  "/open-config-file",
  "/manager",
  "/meta",
  "/api",
  "/assets"
];

export default defineConfig(({ command }) => {
  // The proxy exists only for the development server. A production build must
  // not depend on a running Manager, while development fails closed when no
  // explicit environment URL or complete Host READY identity is available.
  const managerTarget = command === "serve" ? discoverManagerBaseUrl() : "";
  const proxy = managerTarget
    ? Object.fromEntries(managerProxyPaths.map((path) => [path, managerTarget]))
    : {};

  return {
    root,
    plugins: [vue()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@shared": fileURLToPath(new URL("../src/shared", import.meta.url))
      }
    },
    // Relative URLs are required because a Bundle is served below its immutable revision URL.
    base: "./",
    build: {
      target: "esnext",
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        preserveEntrySignatures: "exports-only",
        input: {
          agentCodexPlugin: fileURLToPath(new URL("./src/bundles/agents/codex.ts", import.meta.url)),
          agentCopilotCliPlugin: fileURLToPath(new URL("./src/bundles/agents/copilot-cli.ts", import.meta.url)),
          agentMarvisPlugin: fileURLToPath(new URL("./src/bundles/agents/marvis.ts", import.meta.url)),
          agentAstrbotPlugin: fileURLToPath(new URL("./src/bundles/agents/astrbot.ts", import.meta.url)),
          agentDshPlugin: fileURLToPath(new URL("./src/bundles/agents/dsh.ts", import.meta.url)),
          agentWorkbuddyPlugin: fileURLToPath(new URL("./src/bundles/agents/workbuddy.ts", import.meta.url)),
          agentAntigravityPlugin: fileURLToPath(new URL("./src/bundles/agents/antigravity.ts", import.meta.url)),
          agentDevicePlugin: fileURLToPath(new URL("./src/bundles/agents/device-agent.ts", import.meta.url)),
          agentGrokBotPlugin: fileURLToPath(new URL("./src/bundles/agents/grok-bot.ts", import.meta.url)),
          app: fileURLToPath(new URL("./index.html", import.meta.url)),
          managerCorePlugin: fileURLToPath(new URL("./src/bundles/builtin/core.ts", import.meta.url)),
          managerRouteControlPlugin: fileURLToPath(new URL("./src/bundles/builtin/route-control.ts", import.meta.url)),
          managerMessageAdapterControlPlugin: fileURLToPath(new URL("./src/bundles/builtin/message-adapter-control.ts", import.meta.url)),
          managerPersonaPlugin: fileURLToPath(new URL("./src/bundles/builtin/persona.ts", import.meta.url)),
          managerSpeechPlugin: fileURLToPath(new URL("./src/bundles/builtin/speech.ts", import.meta.url)),
          speechEndpointPlugin: fileURLToPath(new URL("./src/bundles/endpoints/speech.ts", import.meta.url)),
          managerVideoPlugin: fileURLToPath(new URL("./src/bundles/builtin/video.ts", import.meta.url)),
          managerPerformancePlugin: fileURLToPath(new URL("./src/bundles/builtin/performance.ts", import.meta.url)),
          managerDiagnosticsPlugin: fileURLToPath(new URL("./src/bundles/builtin/diagnostics.ts", import.meta.url)),
          managerDesktopPlugin: fileURLToPath(new URL("./src/bundles/builtin/desktop.ts", import.meta.url)),
          managerXiaomiHomePlugin: fileURLToPath(new URL("./src/bundles/builtin/xiaomi-home.ts", import.meta.url)),
          endpointNapcatPlugin: fileURLToPath(new URL("./src/bundles/endpoints/napcat.ts", import.meta.url)),
          endpointHeartbeatPlugin: fileURLToPath(new URL("./src/bundles/endpoints/heartbeat.ts", import.meta.url)),
          endpointWecomPlugin: fileURLToPath(new URL("./src/bundles/endpoints/wecom.ts", import.meta.url)),
          endpointWeixinPlugin: fileURLToPath(new URL("./src/bundles/endpoints/weixin.ts", import.meta.url)),
          endpointFeishuPlugin: fileURLToPath(new URL("./src/bundles/endpoints/feishu.ts", import.meta.url)),
          endpointWebhookPlugin: fileURLToPath(new URL("./src/bundles/endpoints/webhook.ts", import.meta.url)),
          endpointRabilinkPlugin: fileURLToPath(new URL("./src/bundles/endpoints/rabilink.ts", import.meta.url))
        }
      }
    },
    server: {
      port: 8793,
      proxy
    }
  };
});

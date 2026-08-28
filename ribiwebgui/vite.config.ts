import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        managerCorePlugin: fileURLToPath(new URL("./src/bundles/builtin/core.ts", import.meta.url)),
        managerMessageAdapterControlPlugin: fileURLToPath(new URL("./src/bundles/builtin/message-adapter-control.ts", import.meta.url)),
        managerPersonaPlugin: fileURLToPath(new URL("./src/bundles/builtin/persona.ts", import.meta.url)),
        managerSpeechPlugin: fileURLToPath(new URL("./src/bundles/builtin/speech.ts", import.meta.url)),
        managerPerformancePlugin: fileURLToPath(new URL("./src/bundles/builtin/performance.ts", import.meta.url)),
        managerDiagnosticsPlugin: fileURLToPath(new URL("./src/bundles/builtin/diagnostics.ts", import.meta.url)),
        managerDesktopPlugin: fileURLToPath(new URL("./src/bundles/builtin/desktop.ts", import.meta.url))
      }
    }
  },
  server: {
    port: 8793,
    proxy: {
      "/gateways": "http://127.0.0.1:8790",
      "/network-options": "http://127.0.0.1:8790",
      "/open-config-file": "http://127.0.0.1:8790",
      "/manager": "http://127.0.0.1:8790",
      "/meta": "http://127.0.0.1:8790",
      "/api": "http://127.0.0.1:8790",
      "/assets": "http://127.0.0.1:8790"
    }
  }
});

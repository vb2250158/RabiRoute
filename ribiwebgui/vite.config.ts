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
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      preserveEntrySignatures: "exports-only",
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        rabiManagerBaseClient: fileURLToPath(new URL("./src/bundles/rabiManagerBaseClient.ts", import.meta.url))
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

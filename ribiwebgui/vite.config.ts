import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 8791,
    proxy: {
      "/gateways": "http://127.0.0.1:8790",
      "/network-options": "http://127.0.0.1:8790",
      "/open-config-file": "http://127.0.0.1:8790",
      "/manager": "http://127.0.0.1:8790",
      "/meta": "http://127.0.0.1:8790",
      "/assets": "http://127.0.0.1:8790"
    }
  }
});

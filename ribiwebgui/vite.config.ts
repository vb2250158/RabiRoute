import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { defineConfig } from "vite";
import { webRuntimeVitePlugin } from "../scripts/lib/plugin-web-runtime.mjs";
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
    plugins: [vue(), webRuntimeVitePlugin(path.resolve(root, ".."))],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
        "@rabiroute/host-api": fileURLToPath(new URL("../src", import.meta.url))
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
        // Business Web entries are built once by the official package producer.
        input: { app: fileURLToPath(new URL("./index.html", import.meta.url)) }
      }
    },
    server: {
      port: 8793,
      proxy
    }
  };
});

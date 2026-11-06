import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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
        input: {
          app: fileURLToPath(new URL("./index.html", import.meta.url)),
          ...Object.fromEntries(readdirSync(path.resolve(root, "../src/plugins"), { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .flatMap(entry => {
              const directory = path.resolve(root, "../src/plugins", entry.name);
              let metadata;
              try { metadata = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
              return metadata.rabi?.webSource ? [[entry.name, path.join(directory, metadata.rabi.webSource)]] : [];
            }))
        }
      }
    },
    server: {
      port: 8793,
      proxy
    }
  };
});

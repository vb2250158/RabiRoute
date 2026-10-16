import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// These read-only native bridges belong to the adapter distribution; credentials are never copied.
const resources = ["grok-bot-native-profile.ps1", "resolve-manager.mjs", "lib/discover-manager-url.mjs"];
for (const name of resources) {
  const destination = path.join(root, "dist", "scripts", name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts", name), destination);
}

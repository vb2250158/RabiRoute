import path from "node:path";
import { upgradePersonaMessageConfig, restorePersonaMessageConfig } from "../dist/manager/personaConfigUpgrade.js";

const args = process.argv.slice(2);
const flags = new Set(["--apply", "--offline", "--help"]);
const values = new Set(["--root", "--route-root", "--roles-root", "--backup-dir", "--restore"]);
const parsed = new Map();
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flags.has(flag)) continue;
  if (!values.has(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option: ${flag}`);
  parsed.set(flag, args[++index]);
}
if (args.includes("--help")) {
  console.log("node scripts/upgrade-persona-message-config.mjs --root <application-root> [--route-root <routes>] [--roles-root <roles>] [--apply --offline] [--backup-dir <private-directory>]\nRestore: --restore <snapshot-directory> --apply --offline\nDefault: preview only; configuration contents are never printed.");
} else if (parsed.has("--restore")) {
  if (!args.includes("--apply")) throw new Error("Restoring requires --apply --offline.");
  console.log(JSON.stringify(restorePersonaMessageConfig(parsed.get("--restore"), args.includes("--offline"))));
} else {
  if (!parsed.has("--root")) throw new Error("Specify --root <application-root>; use --help for usage.");
  console.log(JSON.stringify(upgradePersonaMessageConfig({
    root: path.resolve(parsed.get("--root")), routeRoot: parsed.get("--route-root"), rolesRoot: parsed.get("--roles-root"),
    backupDir: parsed.get("--backup-dir"), apply: args.includes("--apply"), offline: args.includes("--offline")
  })));
}

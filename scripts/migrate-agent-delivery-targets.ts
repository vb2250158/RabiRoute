import fs from "node:fs";
import path from "node:path";
import { migrateAgentDeliveryFiles } from "../src/manager/agentDeliveryMigrationFiles.js";
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--persona") || !args.includes("--routes")) {
  throw new Error("Usage: node --import tsx scripts/migrate-agent-delivery-targets.ts --persona <personaConfig.json> --routes <route-root> [--apply]");
}
const personaPath = path.resolve(option("--persona"));
const roleId = path.basename(path.dirname(personaPath));
const root = path.resolve(option("--routes"));
const routePaths = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
  const file = path.join(root, entry.name, "adapterConfig.json");
  if (!fs.existsSync(file)) return [];
  const route = JSON.parse(fs.readFileSync(file, "utf8"));
  return route.agentRoleId === roleId && !route.agentRoleDeviceId ? [file] : [];
});
if (!routePaths.length) throw new Error("No local Routes reference this persona; no files were changed.");
const result = migrateAgentDeliveryFiles({ personaPath, routePaths, apply: args.includes("--apply") });
console.log(JSON.stringify({ ...result, applied: args.includes("--apply") }));

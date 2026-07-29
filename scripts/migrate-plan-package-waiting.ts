import process from "node:process";
import { migratePackageWaitingPlans } from "../src/planPackageMigration.js";

function argValue(name: string): string {
  const prefix = name + "=";
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

const roleDir = argValue("--role-dir");
const rolesRoot = argValue("--roles-root");
if (!roleDir && !rolesRoot) {
  process.stderr.write("Provide --role-dir=<path> or --roles-root=<path>. Run without --apply for a dry-run first.\n");
  process.exit(2);
}

try {
  const report = migratePackageWaitingPlans({
    roleDir: roleDir || undefined,
    rolesRoot: rolesRoot || undefined,
    apply: process.argv.includes("--apply")
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
}

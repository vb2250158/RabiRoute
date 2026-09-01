import { recoverPlanFeedbackStoreTransactions } from "../planFeedback.js";
import { recoverPlanLifecycleTransitions } from "../planStorageRepository.js";
import { recoverPersonaSyncPlanPackageTransactions } from "../personaSyncPlanPackage.js";
import { migrateRolePlanLayoutAtStartup } from "./planStorageStartupMigration.js";
import {
  PlanStorageStartupGateError,
  runPlanStorageStartupGate,
  type PlanStorageStartupGateSummary
} from "./planStorageStartupGate.js";

type StartupInput = Readonly<{
  rolesRoot: string;
  readOnly: boolean;
}>;

type StartupResult =
  | Readonly<{ ok: true; summary: PlanStorageStartupGateSummary }>
  | Readonly<{ ok: false; error: string; summary?: PlanStorageStartupGateSummary }>;

function inputFromEnvironment(): StartupInput {
  const encoded = process.env.RABIROUTE_PLAN_STORAGE_STARTUP_INPUT;
  if (!encoded) throw new Error("Plan storage startup child input is missing.");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<StartupInput>;
  if (typeof parsed.rolesRoot !== "string" || parsed.rolesRoot.trim().length === 0) {
    throw new Error("Plan storage startup child requires rolesRoot.");
  }
  return Object.freeze({ rolesRoot: parsed.rolesRoot, readOnly: parsed.readOnly === true });
}

function sendAndExit(result: StartupResult, exitCode: number): void {
  if (typeof process.send !== "function") {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exit(exitCode);
    return;
  }
  process.send(result, () => {
    process.disconnect();
    process.exit(exitCode);
  });
}

try {
  const input = inputFromEnvironment();
  const summary = await runPlanStorageStartupGate({
    rolesRoot: input.rolesRoot,
    readOnly: input.readOnly,
    recoverRoleLifecycle: async roleDir => recoverPlanLifecycleTransitions(roleDir),
    migrateRole: async roleDir => migrateRolePlanLayoutAtStartup(roleDir),
    recoverRoleFeedback: async roleDir => recoverPlanFeedbackStoreTransactions(roleDir),
    recoverRolePackages: async roleDir => recoverPersonaSyncPlanPackageTransactions(roleDir)
  });
  sendAndExit({ ok: true, summary }, 0);
} catch (error) {
  sendAndExit({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    summary: error instanceof PlanStorageStartupGateError ? error.summary : undefined
  }, 1);
}

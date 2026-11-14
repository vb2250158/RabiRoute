import path from "node:path";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import {
  acquireManagerInstanceLock,
  ManagerInstanceAlreadyRunningError
} from "./managerInstanceLock.js";
import { installManagerRuntimeDiagnostics } from "./managerRuntimeDiagnostics.js";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";
import { bindLinuxHostParentLifetime } from "./linuxHostParent.js";

bindLinuxHostParentLifetime();

const managerRuntimeLayout = resolveRuntimeLayout(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);
const projectRoot = managerRuntimeLayout.packageRoot;
const explicitInstanceLockRoot = process.env.RABIROUTE_MANAGER_INSTANCE_LOCK_DIR?.trim();
const programDataInstanceRoot = process.platform === "win32" && process.env.PROGRAMDATA?.trim()
  ? path.join(process.env.PROGRAMDATA.trim(), "RabiRoute", "single-instance")
  : undefined;
const localAppDataInstanceRoot = process.platform === "win32" && process.env.LOCALAPPDATA?.trim()
  ? path.join(process.env.LOCALAPPDATA.trim(), "RabiRoute", "single-instance")
  : undefined;
// A Windows RabiRoute install is one local product, even when old installs or
// a NAS checkout point at different project roots. The explicit environment
// override remains for isolated development and tests.
const defaultInstanceLockRoot = programDataInstanceRoot || localAppDataInstanceRoot || projectRoot;
const requestedTestOwnershipNamespace = process.env.RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE?.trim();
const acceptanceOwnershipAllowed = process.env.RABIROUTE_MANAGER_ACCEPTANCE_MODE === "1"
  && process.env.RABIROUTE_MANAGER_READ_ONLY === "1"
  && process.env.RABIROUTE_MANAGER_AUTOSTART === "0"
  && process.env.RABIROUTE_HOSTED !== "1";
if (requestedTestOwnershipNamespace && !acceptanceOwnershipAllowed) {
  throw new Error("RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE is restricted to isolated read-only acceptance runs.");
}
const testOwnershipNamespace = acceptanceOwnershipAllowed
  ? requestedTestOwnershipNamespace
  : undefined;

async function acquireMachineInstanceLock() {
  const primaryRoot = path.resolve(explicitInstanceLockRoot || defaultInstanceLockRoot);
  try {
    return await acquireManagerInstanceLock({
      rootDir: primaryRoot,
      ownershipNamespace: testOwnershipNamespace
    });
  } catch (error) {
    const fallbackRoot = localAppDataInstanceRoot && path.resolve(localAppDataInstanceRoot);
    if (
      explicitInstanceLockRoot
      || !fallbackRoot
      || fallbackRoot === primaryRoot
      || error instanceof ManagerInstanceAlreadyRunningError
    ) {
      throw error;
    }
    return await acquireManagerInstanceLock({
      rootDir: fallbackRoot,
      ownershipNamespace: testOwnershipNamespace
    });
  }
}

const runtimeDiagnostics = installManagerRuntimeDiagnostics({ rootDir: managerRuntimeLayout.stateRoot });

void (async () => {
let instanceLock: Awaited<ReturnType<typeof acquireMachineInstanceLock>> | undefined;
try {
  // Host owns the Windows application generation, while this lock owns the
  // single state-writing Manager process. Both hosted and source-mode starts
  // must contend for it so an old/manual Manager cannot become a second owner.
  instanceLock = await acquireMachineInstanceLock();
  const ownedInstanceLock = instanceLock;
  process.once("exit", () => { void ownedInstanceLock.release(); });
  // Storage adoption runs under the application's exclusive owner before any
  // plugin opens its stores. Explicit settings retain precedence over .env.
  dotenv.config({ path: path.join(managerRuntimeLayout.stateRoot, ".env") });
  const { consumeConfirmedDataUpgrades } = await import("./manager/dataUpgradeOperations.js");
  const { ManagerConfigRepository } = await import("./manager/configRepository.js");
  const startupConfig = new ManagerConfigRepository({ rootDir: managerRuntimeLayout.stateRoot, managerPort: 0 });
  await consumeConfirmedDataUpgrades(managerRuntimeLayout, startupConfig.rolesRoot,
    process.env.RABIROUTE_MANAGER_READ_ONLY === "1");
  void import("./manager/controlPlaneRoutes.js")
    .then(({ startManager }) => startManager({ instanceLock: ownedInstanceLock }))
    .catch(async (error) => {
      await ownedInstanceLock.release().catch((cleanupError) => {
        runtimeDiagnostics.record("startup_failure", { error: cleanupError });
      });
      runtimeDiagnostics.record("startup_failure", { error });
      console.error(error);
      // A plugin may already have created child processes or other live handles.
      // A fatal startup failure must not leave a lock-owning zombie Manager.
      process.exit(1);
    });
} catch (error) {
  await instanceLock?.release().catch((cleanupError) => {
    runtimeDiagnostics.record("startup_failure", { error: cleanupError });
  });
  runtimeDiagnostics.record("startup_failure", { error });
  if (error instanceof ManagerInstanceAlreadyRunningError) {
    console.error(`RabiRoute Manager single-instance guard refused a duplicate start: pid=${error.owner.pid}.`);
    process.exitCode = 17;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
})();

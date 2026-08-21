import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireManagerInstanceLock,
  ManagerInstanceAlreadyRunningError
} from "./managerInstanceLock.js";
import { installManagerRuntimeDiagnostics } from "./managerRuntimeDiagnostics.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDiagnostics = installManagerRuntimeDiagnostics({ rootDir: projectRoot });

try {
  const instanceLock = acquireManagerInstanceLock({ rootDir: projectRoot });
  process.once("exit", () => instanceLock.release());
  void import("./manager/controlPlaneRoutes.js")
    .then(({ startManager }) => startManager())
    .catch(async (error) => {
      await import("./runtime/managerCordisRoot.js")
        .then(({ getBuiltinManagerCordisRoot }) => getBuiltinManagerCordisRoot().dispose())
        .catch(() => {});
      instanceLock.release();
      runtimeDiagnostics.record("startup_failure", { error });
      console.error(error);
      process.exitCode = 1;
    });
} catch (error) {
  runtimeDiagnostics.record("startup_failure", { error });
  if (error instanceof ManagerInstanceAlreadyRunningError) {
    console.error(`RabiRoute Manager single-instance guard refused a duplicate start: pid=${error.owner.pid}.`);
    process.exitCode = 17;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}

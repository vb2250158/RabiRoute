import { startManager } from "./manager/controlPlaneRoutes.js";

void startManager().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MiHealthSummary } from "../types/mi-health-summary";

const execFileAsync = promisify(execFile);

async function readMiHealthSummary(serial = ""): Promise<MiHealthSummary> {
  const { stdout } = await execFileAsync("node", [
    fileURLToPath(new URL("./read-mi-health-summary.mjs", import.meta.url)),
    "--serial",
    serial,
  ]);

  return JSON.parse(stdout) as MiHealthSummary;
}

const summary = await readMiHealthSummary(process.argv[2]);

console.log({
  heartRateStatus: summary.heartRate.latest.status,
  heartRateBpm: summary.heartRate.latest.bpm,
  sleepScheduleStatus: summary.sleep.scheduleStatus,
  healthConnectStatus: summary.healthConnect.status,
});

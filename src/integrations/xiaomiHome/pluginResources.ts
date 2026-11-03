import path from "node:path";
import { fileURLToPath } from "node:url";

type XiaomiHomePluginResources = Readonly<{ homeAssistantInstallScript: string; vacuumVideoWorker: string }>;
let packageResources: XiaomiHomePluginResources | undefined;

/** One implementation generation owns its immutable resource locations. Source tests retain their existing local paths. */
export function configureXiaomiHomePluginResources(resources: XiaomiHomePluginResources): void {
  if (!path.isAbsolute(resources.homeAssistantInstallScript) || !path.isAbsolute(resources.vacuumVideoWorker)) throw new Error("Xiaomi Home plugin resources require absolute package paths.");
  packageResources = Object.freeze({ ...resources });
}

export function xiaomiHomeInstallScriptPath(): string {
  return packageResources?.homeAssistantInstallScript ?? fileURLToPath(new URL("../../../scripts/Install-HomeAssistantOs.ps1", import.meta.url));
}

export function xiaomiHomeVideoWorkerPath(): string {
  return packageResources?.vacuumVideoWorker ?? fileURLToPath(new URL("./vacuumVideoWorker.js", import.meta.url));
}

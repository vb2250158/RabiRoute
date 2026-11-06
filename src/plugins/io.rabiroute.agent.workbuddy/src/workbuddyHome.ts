import os from "node:os";
import path from "node:path";

/** Shared by Hook installation and session discovery; explicit configuration wins. */
export function workbuddyHomeDir(): string {
  const configured = process.env.RABI_WORKBUDDY_HOME?.trim()
    || process.env.WORKBUDDY_CONFIG_DIR?.trim()
    || process.env.CODEBUDDY_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".workbuddy");
}

import fs from "node:fs";
import path from "node:path";

/** Test ownership remains read-only and cannot start route ingress. */
export function permitsAcceptanceOwnership(env: NodeJS.ProcessEnv): boolean {
  if (env.RABIROUTE_MANAGER_ACCEPTANCE_MODE !== "1" || env.RABIROUTE_MANAGER_READ_ONLY !== "1"
    || env.RABIROUTE_MANAGER_AUTOSTART !== "0") return false;
  if (env.RABIROUTE_HOSTED !== "1") return true;
  return env.RABIROUTE_HOST_ACCEPTANCE === "1" && isHostedFixture(env);
}

function isHostedFixture(env: NodeJS.ProcessEnv): boolean {
  const value = env.RABIROUTE_STATE_ROOT;
  if (!value || !path.isAbsolute(value) || !env.RABIROUTE_APPLICATION_GENERATION_ID
    || !env.RABIROUTE_HOST_CONTROL_TOKEN || !/^RabiRoute\.Host\.Acceptance\.[A-F0-9]{16}$/.test(env.RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE || "")) return false;
  const normalize = (input: string) => process.platform === "win32" ? path.resolve(input).toUpperCase() : path.resolve(input);
  const root = normalize(value);
  if (["USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP"].some(key => !env[key] || normalize(env[key]!) !== root)) return false;
  if (!env.RABIROUTE_ACCEPTANCE_TEMP_PARENT || normalize(env.RABIROUTE_ACCEPTANCE_TEMP_PARENT) !== normalize(path.dirname(value))) return false;
  if (!env.RABIROUTE_MANAGER_INSTANCE_LOCK_DIR || normalize(env.RABIROUTE_MANAGER_INSTANCE_LOCK_DIR) !== normalize(path.join(value, "acceptance-lock"))) return false;
  try {
    const info = fs.lstatSync(value);
    if (!info.isDirectory() || info.isSymbolicLink() || normalize(fs.realpathSync(value)) !== root || fs.existsSync(path.join(value, ".env"))) return false;
    const marker = path.join(value, ".rabiroute-acceptance"), metadata = fs.lstatSync(marker);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === Buffer.byteLength("RabiRoute isolated acceptance fixture v1")
      && fs.readFileSync(marker, "utf8") === "RabiRoute isolated acceptance fixture v1";
  } catch { return false; }
}

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { DeviceIdentityError, DeviceIdentityOwner, type OfflineIdentityLease } from "./deviceIdentity.js";

export function runDeviceIdentityCli(args: string[]): unknown {
  const [command, ...argumentsList] = args;
  if (command !== "reset" && command !== "recover") throw new DeviceIdentityError("identity_command_invalid");
  const allowed = new Set(command === "reset"
    ? ["--state-root", "--expected-guid", "--operation-id", "--name", "--device-id", "--offline-lease"]
    : ["--state-root", "--expected-guid", "--operation-id", "--offline-lease"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index], value = argumentsList[index + 1];
    if (!allowed.has(option) || values.has(option) || !value || value.startsWith("--")) throw new DeviceIdentityError("identity_arguments_invalid");
    values.set(option, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new DeviceIdentityError("identity_arguments_missing");
    return value;
  };
  const leasePath = required("--offline-lease");
  if (fs.statSync(leasePath).size > 4096) throw new DeviceIdentityError("identity_offline_lease_invalid");
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf8")) as OfflineIdentityLease;
  const owner = new DeviceIdentityOwner(required("--state-root"));
  return command === "reset"
    ? owner.resetOffline({ expectedGuid: required("--expected-guid"), operationId: required("--operation-id"), name: values.get("--name"), deviceId: values.get("--device-id"), lease })
    : owner.recoverOffline({ operationId: required("--operation-id"), expectedGuid: required("--expected-guid"), lease });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify({ ok: true, receipt: runDeviceIdentityCli(process.argv.slice(2)) })}\n`); }
  catch (error) {
    // Raw IO/JSON/registry errors could contain private paths or data.
    const code = error instanceof DeviceIdentityError ? error.code : "identity_operation_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  }
}

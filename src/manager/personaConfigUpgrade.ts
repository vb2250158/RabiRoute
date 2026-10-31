import fs from "node:fs";
import { recordDataMutationAudit, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ManagerConfigRepository } from "./configRepository.js";
import { ROLE_CONFIGURATION_KEYS } from "../shared/roleConfiguration.js";
import { sanitizeConfigName, sanitizeRoleId } from "../shared/routeIdentity.js";
import { normalizeAgentRoleDeviceId } from "../shared/remotePersonaReference.js";

type Change = { file: string; before: Buffer | null; after: Buffer | null };
type Entry = { file: string; beforeHash: string | null; afterHash: string | null };
type Receipt = { schemaVersion: 1; state: string; entries: Entry[]; audit?: RecordedDataMutationAudit[] };
const hash = (bytes: Buffer | null) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const read = (file: string): Buffer | null => {
  try { return fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};
const equal = (left: Buffer | null, right: Buffer | null) => left === null ? right === null : right !== null && left.equals(right);

function jsonObject(bytes: Buffer, file: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Invalid JSON: ${file}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object: ${file}`);
  return value as Record<string, unknown>;
}

function configurationFiles(root: string, kind: "roles" | "routes"): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Linked configuration directory requires review: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    for (const name of kind === "roles" ? ["personaConfig.json", "roleMessageConfig.json", "routes.json"] : ["adapterConfig.json"]) {
      const file = path.join(root, entry.name, name);
      if (!fs.existsSync(file)) continue;
      if ((kind === "roles" ? sanitizeRoleId(entry.name) : sanitizeConfigName(entry.name)) !== entry.name) throw new Error(`Configuration directory name requires review: ${entry.name}`);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Linked configuration file requires review: ${file}`);
      const bytes = fs.readFileSync(file);
      const value = jsonObject(bytes, file);
      if ((name === "roleMessageConfig.json" || name === "routes.json") && Object.keys(value).some(key => !["notificationRules", "configs"].includes(key))) {
        throw new Error(`Unknown legacy configuration fields require review: ${file}`);
      }
      if ((name === "roleMessageConfig.json" || name === "routes.json") && Array.isArray(value.configs) && value.configs.some(item =>
        !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["notificationRules", "id", "name", "routeName", "configName"].includes(key)))) {
        throw new Error(`Unknown nested legacy configuration fields require review: ${file}`);
      }
      files.set(`${kind}/${entry.name}/${name}`, bytes);
    }
  }
  return files;
}

function replace(file: string, bytes: Buffer | null): void {
  if (bytes === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.upgrade-tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function publish(changes: Change[], snapshot: string, beforeWrite?: (index: number) => void) {
  fs.mkdirSync(snapshot, { recursive: true });
  const entries = changes.map(({ file, before, after }) => ({ file, beforeHash: hash(before), afterHash: hash(after) }));
  const receipt: Receipt = { schemaVersion: 1, state: "prepared", entries };
  for (const [index, change] of changes.entries()) {
    if (change.before !== null) fs.writeFileSync(path.join(snapshot, `${index}.before`), change.before, { flag: "wx" });
    if (change.after !== null) fs.writeFileSync(path.join(snapshot, `${index}.after`), change.after, { flag: "wx" });
  }
  const saveReceipt = () => replace(path.join(snapshot, "manifest.json"), Buffer.from(JSON.stringify(receipt, null, 2)));
  const audit = (outcome: "started" | "committed" | "failed") => {
    (receipt.audit ??= []).push(recordDataMutationAudit({ group: "persona", event: "persona_config_migration",
      owner: "persona-config-upgrade", action: "publish", operationId: path.basename(snapshot),
      target: { type: "configuration-migration", id: path.basename(snapshot) },
      dataSource: { kind: "file", id: "persona-route-configurations" }, outcome, result: receipt.state,
      before: { digest: createHash("sha256").update(JSON.stringify(entries.map(entry => entry.beforeHash))).digest("hex") },
      after: { digest: createHash("sha256").update(JSON.stringify(entries.map(entry => entry.afterHash))).digest("hex") },
      changes: [{ field: "files", to: changes.length }] }));
  };
  audit("started");
  saveReceipt();
  const written: Change[] = [];
  try {
    for (const change of changes) if (!equal(read(change.file), change.before)) throw new Error("Configuration changed since preview; no migration was started.");
    for (const [index, change] of changes.entries()) {
      beforeWrite?.(index);
      if (!equal(read(change.file), change.before)) throw new Error("Configuration changed during migration.");
      replace(change.file, change.after);
      written.push(change);
      if (!equal(read(change.file), change.after)) throw new Error("Migration readback failed.");
    }
    for (const change of changes) if (!equal(read(change.file), change.after)) throw new Error("Configuration changed before migration commit.");
    receipt.state = "committed";
    audit("committed");
    saveReceipt();
    return { changedFiles: changes.length, applied: true, snapshot };
  } catch (error) {
    let restored = true;
    for (const change of written.reverse()) {
      try {
        if (!equal(read(change.file), change.after)) { restored = false; continue; }
        replace(change.file, change.before);
        if (!equal(read(change.file), change.before)) restored = false;
      } catch { restored = false; }
    }
    receipt.state = restored ? "restored" : "recovery_required";
    audit("failed");
    saveReceipt();
    throw new Error(`Upgrade failed; ${receipt.state}. Snapshot: ${snapshot}`, { cause: error });
  }
}

export type PersonaConfigUpgradeOptions = {
  root: string; routeRoot?: string; rolesRoot?: string; apply?: boolean; offline?: boolean;
  backupDir?: string; beforeWrite?: (index: number) => void;
};

export function upgradePersonaMessageConfig(options: PersonaConfigUpgradeOptions) {
  if (options.apply && !options.offline) throw new Error("Stop the application and pass --offline before applying configuration changes.");
  const root = path.resolve(options.root);
  const managerBytes = read(path.join(root, "data", "manager.json"));
  const manager = managerBytes ? jsonObject(managerBytes, "data/manager.json") : {};
  const routeRoot = path.resolve(root, options.routeRoot ?? String(manager.routeDir ?? "data/route"));
  const rolesRoot = path.resolve(root, options.rolesRoot ?? String(manager.rolesDir ?? "data/roles"));
  if (!fs.existsSync(routeRoot) && !fs.existsSync(rolesRoot)) throw new Error("No persona or Route configuration directories found; check --root and directory overrides.");
  if (routeRoot === rolesRoot) throw new Error("Route and persona configuration roots must be different.");
  const originals = new Map([...configurationFiles(rolesRoot, "roles"), ...configurationFiles(routeRoot, "routes")]);
  for (const [key, bytes] of originals) {
    if (!key.startsWith("routes/")) continue;
    const value = jsonObject(bytes, key);
    if (value.agentRoleDeviceId && !normalizeAgentRoleDeviceId(value.agentRoleDeviceId)) throw new Error(`Invalid remote persona source: ${key}`);
    if (value.agentRoleDeviceId) continue;
    const legacyKeys = [...ROLE_CONFIGURATION_KEYS, "routeProfiles", "roleNotificationRules", "roleRouteNames"];
    if (!value.agentRoleId && legacyKeys.some(field => value[field] !== undefined)) throw new Error(`Unbound Route has persona settings; bind it before upgrading: ${key}`);
    if (value.agentRoleId && (sanitizeRoleId(value.agentRoleId) !== value.agentRoleId || !fs.existsSync(path.join(rolesRoot, String(value.agentRoleId))))) throw new Error(`Referenced persona is missing or invalid: ${key}`);
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const stage = fs.mkdtempSync(path.join(temporaryRoot, "rabi-config-upgrade-"));
  try {
    for (const [key, bytes] of originals) replace(path.join(stage, key), bytes);
    // Reuse the runtime's ownership and Agent-target migrations, never a second converter.
    const repository = new ManagerConfigRepository({ rootDir: stage, routeRoot: path.join(stage, "routes"), rolesRoot: path.join(stage, "roles"), managerPort: 0 });
    repository.migrateLegacyConfigs();
    // Normalize rules generated by the Agent-target migration in the same transaction.
    repository.migrateLegacyConfigs();
    const candidates = new Map([...configurationFiles(path.join(stage, "roles"), "roles"), ...configurationFiles(path.join(stage, "routes"), "routes")]);
    const changes: Change[] = [];
    for (const key of new Set([...originals.keys(), ...candidates.keys()])) {
      const before = originals.get(key) ?? null;
      const after = candidates.get(key) ?? null;
      if (equal(before, after)) continue;
      const parts = key.split("/");
      const file = path.join(parts[0] === "roles" ? rolesRoot : routeRoot, ...parts.slice(1));
      changes.push({ file, before, after });
    }
    if (!options.apply || !changes.length) return { changedFiles: changes.length, applied: false, snapshot: null };
    if (!equal(read(path.join(root, "data", "manager.json")), managerBytes)) throw new Error("Global configuration changed since preview.");
    for (const [key, original] of originals) {
      const [kind, ...parts] = key.split("/");
      if (!equal(read(path.join(kind === "roles" ? rolesRoot : routeRoot, ...parts)), original)) throw new Error("Configuration changed since preview; no migration was started.");
    }
    const backup = path.resolve(options.backupDir ?? path.join(root, "data", "config-upgrade-backups"), randomUUID());
    return publish(changes, backup, options.beforeWrite);
  } finally {
    if (path.dirname(stage) !== temporaryRoot || !path.basename(stage).startsWith("rabi-config-upgrade-")) throw new Error("Unexpected staging path.");
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function restorePersonaMessageConfig(snapshot: string, offline: boolean) {
  if (!offline) throw new Error("Stop the application and pass --offline before restoring configuration.");
  const directory = path.resolve(snapshot);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as Receipt;
  if (receipt.schemaVersion !== 1 || !["prepared", "recovery_required", "committed"].includes(receipt.state) || !Array.isArray(receipt.entries)) throw new Error("Snapshot is not a recoverable configuration upgrade.");
  const changes = receipt.entries.flatMap((entry, index): Change[] => {
    const before = read(path.join(directory, `${index}.after`));
    const after = read(path.join(directory, `${index}.before`));
    if (hash(before) !== entry.afterHash || hash(after) !== entry.beforeHash) throw new Error("Snapshot integrity check failed.");
    const current = read(entry.file);
    if (receipt.state !== "committed" && equal(current, after)) return [];
    if (!equal(current, before)) throw new Error("Configuration changed since upgrade; no restore was started.");
    return [{ file: entry.file, before, after }];
  });
  if (!changes.length) return { changedFiles: 0, applied: false, snapshot: null };
  return publish(changes, path.join(directory, "restore", randomUUID()));
}

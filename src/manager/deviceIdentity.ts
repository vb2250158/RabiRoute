import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadTunnelIdentity } from "../peerTunnel/security.js";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

// Local copy detection, never a peer credential or a field in a public DTO.
export const deviceIdentityConfigField = "_deviceIdentity";
type Binding = { schemaVersion: 1; rabiGuid: string; machineOwner: string; tunnelPublicKeyDigest: string };
type IdentityFile = "config" | "key" | "binding";
type Change = { file: IdentityFile; beforeDigest: string | null; afterDigest: string };
type ResetJournal = { schemaVersion: 1; operationId: string; oldGuid: string; newGuid: string; changes: Change[] };
export type OfflineIdentityLease = { schemaVersion: 1; stateRoot: string; pid: number; nonce: string };
export type DeviceIdentityReceipt = { schemaVersion: 1; operationId: string; oldGuid: string; newGuid: string; completedAt: string; backupDirectory: string; outcome: "committed" | "rolled_back" };
type Options = { machineIdentity?: () => string; afterReplace?: (file: IdentityFile) => void };
const identityFiles: IdentityFile[] = ["config", "key", "binding"];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export class DeviceIdentityError extends Error {
  constructor(readonly code: string) {
    super(`${code}: Device identity requires the offline identity reset/recovery owner.`);
    this.name = "DeviceIdentityError";
  }
}
function denied(code: string): never { throw new DeviceIdentityError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return denied("identity_invalid_record");
  return value as Record<string, unknown>;
}
function boundedRead(file: string, maxBytes = 1024 * 1024): Buffer | null {
  try {
    if (fs.statSync(file).size > maxBytes) return denied("identity_file_too_large");
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function readRecord(file: string, maxBytes?: number): Record<string, unknown> | null {
  const bytes = boundedRead(file, maxBytes);
  if (!bytes) return null;
  try { return record(JSON.parse(bytes.toString("utf8"))); }
  catch { return denied("identity_invalid_record"); }
}
function guidFrom(config: Record<string, unknown>): string {
  if (typeof config.rabiGuid !== "string" || !config.rabiGuid.trim()) return denied("identity_guid_missing");
  return config.rabiGuid.trim();
}
function bindingFrom(value: unknown): Binding {
  const binding = record(value);
  if (binding.schemaVersion !== 1 || typeof binding.rabiGuid !== "string" || !binding.rabiGuid
    || typeof binding.machineOwner !== "string" || !/^[a-f0-9]{64}$/.test(binding.machineOwner)
    || typeof binding.tunnelPublicKeyDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.tunnelPublicKeyDigest)) {
    return denied("identity_binding_invalid");
  }
  return { schemaVersion: 1, rabiGuid: binding.rabiGuid, machineOwner: binding.machineOwner, tunnelPublicKeyDigest: binding.tunnelPublicKeyDigest };
}

export function readOsMachineIdentity(): string {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
        { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"] });
      const match = /MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i.exec(output);
      if (match && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(match[1])) return `win32:${match[1].toLowerCase()}`;
    } else if (process.platform === "linux") {
      const id = fs.readFileSync("/etc/machine-id", "utf8").trim();
      if (/^[a-f0-9]{32}$/i.test(id)) return `linux:${id.toLowerCase()}`;
    } else if (process.platform === "darwin") {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8", timeout: 5000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] });
      const match = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i.exec(output);
      if (match) return `darwin:${match[1].toLowerCase()}`;
    }
  } catch { /* Do not include registry or command output in diagnostics. */ }
  return denied("identity_machine_owner_unavailable");
}

export class DeviceIdentityOwner {
  readonly stateRoot: string;
  private readonly directory: string;
  private readonly paths: Record<IdentityFile, string>;
  private readonly pendingPath: string;
  private readonly lockPath: string;
  private readonly machineOwner: string;

  constructor(stateRoot: string, private readonly options: Options = {}) {
    if (!path.isAbsolute(stateRoot)) denied("identity_absolute_state_root_required");
    this.stateRoot = fs.realpathSync(stateRoot);
    this.directory = path.join(this.stateRoot, "data", "rabilink");
    this.paths = { config: path.join(this.stateRoot, "data", "Config.json"), key: path.join(this.directory, "tunnel-identity.json"), binding: path.join(this.directory, "device-identity.json") };
    this.pendingPath = path.join(this.directory, "identity-reset-pending.json");
    this.lockPath = path.join(this.directory, "identity-owner.lock");
    // Hostname is deliberately excluded: renaming the same PC keeps ownership.
    const machineIdentity = (options.machineIdentity ?? readOsMachineIdentity)();
    if (!machineIdentity || machineIdentity.length > 4096) denied("identity_machine_owner_unavailable");
    this.machineOwner = digest(`RabiRoute/device-identity/v1\0${machineIdentity}`);
    this.assertSafePaths();
  }

  private assertSafePaths(): void {
    for (const file of [...Object.values(this.paths), this.pendingPath, this.lockPath, path.join(this.directory, "identity-resets")]) {
      let current = file;
      while (current !== this.stateRoot) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return denied("identity_symlink_denied");
        const parent = path.dirname(current);
        if (parent === current) return denied("identity_path_escape_denied");
        current = parent;
      }
    }
  }

  // Called before GlobalConfigStore can normalize, create or publish an identity.
  assertStartup(): void {
    this.assertSafePaths();
    if (fs.existsSync(this.pendingPath)) return denied("identity_reset_pending");
    this.assertIdentityFiles();
  }

  private assertIdentityFiles(): void {
    const config = readRecord(this.paths.config);
    const marker = readRecord(this.paths.binding, 4096);
    if (!config) {
      if (marker || fs.existsSync(this.paths.key)) return denied("identity_config_missing");
      return;
    }
    const rawBinding = config[deviceIdentityConfigField];
    if (rawBinding === undefined) {
      if (marker) return denied("identity_config_binding_missing");
      return; // Explicit compatibility: an unbound legacy config is adopted once.
    }
    const binding = bindingFrom(rawBinding);
    if (binding.machineOwner !== this.machineOwner) return denied("identity_foreign_machine");
    if (binding.rabiGuid !== guidFrom(config)) return denied("identity_guid_mismatch");
    if (marker && JSON.stringify(bindingFrom(marker)) !== JSON.stringify(binding)) return denied("identity_binding_mismatch");
    if (!fs.existsSync(this.paths.key)) return denied("identity_tunnel_key_missing");
    const keys = this.readKeys();
    if (digest(keys.publicKey) !== binding.tunnelPublicKeyDigest) return denied("identity_tunnel_key_mismatch");
  }

  ensureBound(readOnly = false): void {
    if (readOnly) { this.assertStartup(); return; }
    withFileLockSync(this.lockPath, () => {
      this.assertStartup();
      const config = readRecord(this.paths.config);
      if (!config) return denied("identity_config_missing");
      const guid = guidFrom(config);
      const keys = this.readKeys(config[deviceIdentityConfigField] === undefined);
      const binding: Binding = { schemaVersion: 1, rabiGuid: guid, machineOwner: this.machineOwner, tunnelPublicKeyDigest: digest(keys.publicKey) };
      if (config[deviceIdentityConfigField] === undefined) {
        atomicWriteFileSync(this.paths.config, jsonBytes({ ...config, [deviceIdentityConfigField]: binding }), { mode: 0o600 });
        this.audit("adopt", "committed", guid);
      }
      if (!fs.existsSync(this.paths.binding)) atomicWriteFileSync(this.paths.binding, jsonBytes(binding), { mode: 0o600 });
      this.assertStartup();
    });
  }

  private readKeys(create = false) {
    try {
      boundedRead(this.paths.key, 16_384);
      return loadTunnelIdentity(this.paths.key, "", "", { create });
    }
    catch { return denied("identity_tunnel_key_invalid"); }
  }

  private validateLease(lease: OfflineIdentityLease): void {
    if (!lease || lease.schemaVersion !== 1 || lease.pid !== process.ppid || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
      || typeof lease.nonce !== "string" || !/^[a-f0-9]{64}$/.test(lease.nonce)
      || typeof lease.stateRoot !== "string" || !path.isAbsolute(lease.stateRoot)
      || fs.realpathSync(lease.stateRoot) !== this.stateRoot) return denied("identity_offline_lease_invalid");
    try { process.kill(lease.pid, 0); }
    catch { return denied("identity_offline_lease_owner_missing"); }
  }

  resetOffline(input: { expectedGuid: string; operationId?: string; name?: string; deviceId?: string; lease: OfflineIdentityLease }): DeviceIdentityReceipt {
    this.validateLease(input.lease);
    return withFileLockSync(this.lockPath, () => {
      this.assertSafePaths();
      const operationId = input.operationId ?? randomUUID();
      const backupDirectory = this.operationDirectory(operationId);
      const prior = this.readReceipt(operationId);
      if (prior) {
        if (prior.outcome !== "committed" || prior.oldGuid !== input.expectedGuid) return denied("identity_operation_conflict");
        this.assertStartup();
        const config = readRecord(this.paths.config);
        if (!config || guidFrom(config) !== prior.newGuid) return denied("identity_operation_conflict");
        return prior;
      }
      if (fs.existsSync(this.pendingPath)) return denied("identity_reset_pending");
      if (fs.existsSync(path.join(backupDirectory, "journal.json"))) return denied("identity_operation_conflict");
      const config = readRecord(this.paths.config);
      if (!config || guidFrom(config) !== input.expectedGuid) return denied("identity_expected_guid_mismatch");
      if (input.name !== undefined && (!input.name.trim() || input.name.length > 256)) return denied("identity_name_invalid");
      if (input.deviceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.deviceId)) return denied("identity_device_id_invalid");
      const newGuid = randomUUID();
      const pair = generateKeyPairSync("ed25519");
      const keys = { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      const binding: Binding = { schemaVersion: 1, rabiGuid: newGuid, machineOwner: this.machineOwner, tunnelPublicKeyDigest: digest(keys.publicKey) };
      const nextConfig = { ...config, rabiGuid: newGuid, ...(input.name === undefined ? {} : { rabiName: input.name.trim() }),
        ...(input.deviceId === undefined ? {} : { rabiLinkRelay: { ...record(config.rabiLinkRelay), deviceId: input.deviceId } }),
        [deviceIdentityConfigField]: binding, updatedAt: new Date().toISOString() };
      const contents: Record<IdentityFile, Buffer> = { config: jsonBytes(nextConfig), key: jsonBytes(keys), binding: jsonBytes(binding) };
      fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const changes = identityFiles.map(file => {
        const before = boundedRead(this.paths[file]);
        if (before) atomicWriteFileSync(path.join(backupDirectory, `${file}.before`), before, { mode: 0o600 });
        return { file, beforeDigest: before ? digest(before) : null, afterDigest: digest(contents[file]) };
      });
      const journal: ResetJournal = { schemaVersion: 1, operationId, oldGuid: input.expectedGuid, newGuid, changes };
      atomicWriteFileSync(path.join(backupDirectory, "journal.json"), jsonBytes(journal), { mode: 0o600 });
      // This barrier makes an interrupted multi-file operation unavailable to startup.
      atomicWriteFileSync(this.pendingPath, jsonBytes(journal), { mode: 0o600 });
      this.audit("reset", "started", operationId);
      try {
        for (const change of changes) {
          this.validateLease(input.lease);
          const current = boundedRead(this.paths[change.file]);
          if ((current ? digest(current) : null) !== change.beforeDigest) return denied("identity_reset_external_change");
          atomicWriteFileSync(this.paths[change.file], contents[change.file], { mode: 0o600 });
          this.options.afterReplace?.(change.file);
        }
        for (const change of changes) if (digest(boundedRead(this.paths[change.file])!) !== change.afterDigest) return denied("identity_reset_verification_failed");
        const receipt: DeviceIdentityReceipt = { schemaVersion: 1, operationId, oldGuid: journal.oldGuid, newGuid, completedAt: new Date().toISOString(), backupDirectory, outcome: "committed" };
        this.writeReceipt(receipt);
        fs.unlinkSync(this.pendingPath);
        this.assertStartup();
        this.audit("reset", "committed", operationId);
        return receipt;
      } catch (error) {
        this.audit("reset", "failed", operationId);
        throw error;
      }
    });
  }

  recoverOffline(input: { operationId: string; expectedGuid?: string; lease: OfflineIdentityLease }): DeviceIdentityReceipt {
    this.validateLease(input.lease);
    return withFileLockSync(this.lockPath, () => {
      this.assertSafePaths();
      const prior = this.readReceipt(input.operationId);
      if (!fs.existsSync(this.pendingPath) && prior) {
        if (input.expectedGuid !== undefined && prior.oldGuid !== input.expectedGuid) return denied("identity_expected_guid_mismatch");
        const config = readRecord(this.paths.config);
        if (!config || guidFrom(config) !== (prior.outcome === "committed" ? prior.newGuid : prior.oldGuid)) return denied("identity_operation_conflict");
        if (prior.outcome === "committed") this.assertStartup();
        return prior;
      }
      const pending = fs.existsSync(this.pendingPath);
      const saved = fs.existsSync(path.join(this.operationDirectory(input.operationId), "journal.json"));
      if (!pending && !saved) {
        this.assertStartup();
        const config = readRecord(this.paths.config);
        if (!config || guidFrom(config) !== input.expectedGuid) return denied("identity_expected_guid_mismatch");
        const receipt: DeviceIdentityReceipt = { schemaVersion: 1, operationId: input.operationId, oldGuid: guidFrom(config), newGuid: guidFrom(config),
          completedAt: new Date().toISOString(), backupDirectory: this.operationDirectory(input.operationId), outcome: "rolled_back" };
        this.writeReceipt(receipt);
        this.audit("recover", "committed", input.operationId);
        return receipt;
      }
      const journal = this.readJournal(input.operationId, pending);
      if (input.expectedGuid !== undefined && journal.oldGuid !== input.expectedGuid) return denied("identity_expected_guid_mismatch");
      const backupDirectory = this.operationDirectory(input.operationId);
      if (prior?.outcome === "committed") {
        for (const change of journal.changes) {
          const current = boundedRead(this.paths[change.file]);
          if (!current || digest(current) !== change.afterDigest) return denied("identity_recovery_external_change");
        }
        this.assertIdentityFiles();
        fs.unlinkSync(this.pendingPath);
        this.audit("recover", "committed", journal.operationId);
        return prior;
      }
      const backups = new Map<IdentityFile, Buffer | null>();
      const observed = new Map<IdentityFile, string | null>();
      // Validate every file before restoring any: never overwrite independent edits.
      for (const change of journal.changes) {
        const current = boundedRead(this.paths[change.file]);
        const currentDigest = current ? digest(current) : null;
        if (currentDigest !== change.beforeDigest && currentDigest !== change.afterDigest) return denied("identity_recovery_external_change");
        if (!pending && currentDigest !== change.beforeDigest) return denied("identity_recovery_external_change");
        const before = boundedRead(path.join(backupDirectory, `${change.file}.before`));
        if ((before ? digest(before) : null) !== change.beforeDigest) return denied("identity_recovery_backup_invalid");
        backups.set(change.file, before);
        observed.set(change.file, currentDigest);
      }
      this.audit("recover", "started", journal.operationId);
      for (const change of journal.changes) {
        this.validateLease(input.lease);
        const current = boundedRead(this.paths[change.file]);
        if ((current ? digest(current) : null) !== observed.get(change.file)) return denied("identity_recovery_external_change");
        const before = backups.get(change.file)!;
        if (before) atomicWriteFileSync(this.paths[change.file], before, { mode: 0o600 });
        else if (fs.existsSync(this.paths[change.file])) fs.unlinkSync(this.paths[change.file]);
      }
      const receipt: DeviceIdentityReceipt = { schemaVersion: 1, operationId: journal.operationId, oldGuid: journal.oldGuid, newGuid: journal.newGuid, completedAt: new Date().toISOString(), backupDirectory, outcome: "rolled_back" };
      this.writeReceipt(receipt);
      if (pending) fs.unlinkSync(this.pendingPath);
      this.audit("recover", "committed", journal.operationId);
      return receipt;
    });
  }

  private operationDirectory(operationId: string): string {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operationId)) return denied("identity_operation_id_invalid");
    const directory = path.join(this.directory, "identity-resets", operationId);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return denied("identity_symlink_denied");
    return directory;
  }

  private writeReceipt(receipt: DeviceIdentityReceipt): void {
    const { backupDirectory, ...sanitized } = receipt;
    atomicWriteFileSync(path.join(backupDirectory, "receipt.json"), jsonBytes(sanitized), { mode: 0o600 });
  }

  private readReceipt(operationId: string): DeviceIdentityReceipt | null {
    const backupDirectory = this.operationDirectory(operationId);
    const receipt = readRecord(path.join(backupDirectory, "receipt.json"), 4096);
    if (!receipt) return null;
    if (receipt.schemaVersion !== 1 || receipt.operationId !== operationId || typeof receipt.oldGuid !== "string"
      || typeof receipt.newGuid !== "string" || typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))
      || (receipt.outcome !== "committed" && receipt.outcome !== "rolled_back")) return denied("identity_receipt_invalid");
    return { schemaVersion: 1, operationId, oldGuid: receipt.oldGuid, newGuid: receipt.newGuid, completedAt: receipt.completedAt,
      outcome: receipt.outcome, backupDirectory };
  }

  private readJournal(operationId: string, pendingRequired = true): ResetJournal {
    const pointer = pendingRequired ? readRecord(this.pendingPath, 16_384) : null;
    const saved = readRecord(path.join(this.operationDirectory(operationId), "journal.json"), 16_384);
    if (!saved || (pendingRequired && (!pointer || JSON.stringify(pointer) !== JSON.stringify(saved)))) return denied("identity_recovery_journal_invalid");
    const pending = pointer ?? saved;
    if (pending.schemaVersion !== 1 || pending.operationId !== operationId || typeof pending.oldGuid !== "string" || typeof pending.newGuid !== "string"
      || !Array.isArray(pending.changes) || pending.changes.length !== identityFiles.length) return denied("identity_recovery_journal_invalid");
    for (const [index, value] of pending.changes.entries()) {
      const change = record(value);
      if (change.file !== identityFiles[index] || (change.beforeDigest !== null && (typeof change.beforeDigest !== "string" || !/^[a-f0-9]{64}$/.test(change.beforeDigest)))
        || typeof change.afterDigest !== "string" || !/^[a-f0-9]{64}$/.test(change.afterDigest)) return denied("identity_recovery_journal_invalid");
    }
    return pending as ResetJournal;
  }

  private audit(action: string, outcome: "started" | "committed" | "failed", id: string): void {
    recordDataMutationAudit({ group: "config.global", event: `device_identity_${action}`, owner: "DeviceIdentityOwner", action, operationId: id,
      target: { type: "device_identity", id }, dataSource: { kind: "file", id: "data/Config.json + data/rabilink/tunnel-identity.json" }, outcome });
  }
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { XiaomiHomeCredentialSource } from "../../shared/xiaomiHomeAuthContract.js";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import {
  createLocalSecretProtector,
  type LocalSecretProtector
} from "../../shared/localSecretProtection.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";

type PersistedCredential = Readonly<{
  schemaVersion: 1;
  protection: string;
  protectedCredential: string;
  endpointAccountId: string;
  boundBaseUrl: string;
  managedVmId?: string;
  credentialOrigin?: "external";
  providerName?: string;
  providerVersion?: string;
  verifiedAt: string;
  updatedAt: string;
}>;

export type XiaomiHomeCredentialMetadata = Readonly<{
  endpointAccountId: string;
  boundBaseUrl: string;
  managedVmId?: string;
  credentialOrigin?: "external";
  revision: string;
  providerName?: string;
  providerVersion?: string;
  verifiedAt: string;
  updatedAt: string;
}>;

export type XiaomiHomeCredentialResolution = Readonly<{
  token?: string;
  source: XiaomiHomeCredentialSource;
  removable: boolean;
  metadata?: XiaomiHomeCredentialMetadata;
}>;

function controlledToken(value: unknown): string {
  const token = String(value ?? "").trim();
  if (!token || token.length > 16384 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_credential_invalid", "Home Assistant access token is invalid.");
  }
  return token;
}

function controlledOptionalText(value: unknown, maximum: number): string | undefined {
  const text = String(value ?? "").trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function controlledVmId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_managed_vm_invalid", "Managed Home Assistant VM identity is invalid.");
  }
  return value.toLowerCase();
}

function credentialRevision(content: string): string {
  return `xiaomi-credential:${createHash("sha256").update(content).digest("hex")}`;
}

export class XiaomiHomeCredentialStore {
  readonly credentialPath: string;
  private readonly lockPath: string;

  constructor(
    runtimeDir: string,
    private readonly protector: LocalSecretProtector = createLocalSecretProtector(runtimeDir, ".xiaomi-home-credentials.key")
  ) {
    this.credentialPath = path.join(runtimeDir, "credentials.json");
    this.lockPath = `${this.credentialPath}.lock`;
  }

  resolve(): XiaomiHomeCredentialResolution {
    const protectedCredential = this.readProtected();
    if (protectedCredential) return protectedCredential;
    return Object.freeze({ source: "none", removable: false });
  }

  prepare(
    accessToken: unknown,
    boundBaseUrl: string,
    verification: Readonly<{ providerName?: string; providerVersion?: string; managedVmId?: string; credentialOrigin?: "external" }>
  ): string {
    const token = controlledToken(accessToken);
    const current = this.readProtected();
    const now = new Date().toISOString();
    const endpointAccountId = current?.metadata?.endpointAccountId || randomUUID();
    const secret = this.protector.protect(JSON.stringify({ accessToken: token }));
    const persisted: PersistedCredential = {
      schemaVersion: 1,
      protection: this.protector.scheme,
      protectedCredential: secret,
      endpointAccountId,
      boundBaseUrl: controlledOptionalText(boundBaseUrl, 2048)!,
      managedVmId: verification.managedVmId === undefined ? undefined : controlledVmId(verification.managedVmId),
      credentialOrigin: verification.managedVmId === undefined ? verification.credentialOrigin : undefined,
      providerName: controlledOptionalText(verification.providerName, 160),
      providerVersion: controlledOptionalText(verification.providerVersion, 80),
      verifiedAt: now,
      updatedAt: now
    };
    return `${JSON.stringify(persisted, null, 2)}\n`;
  }

  writePrepared(content: string): XiaomiHomeCredentialResolution {
    return withFileLockSync(this.lockPath, () => {
      atomicWriteFileSync(this.credentialPath, content, { mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(this.credentialPath, 0o600);
      return this.readProtected()!;
    });
  }

  write(
    accessToken: unknown,
    boundBaseUrl: string,
    verification: Readonly<{ providerName?: string; providerVersion?: string; managedVmId?: string; credentialOrigin?: "external" }>
  ): XiaomiHomeCredentialResolution {
    return this.writePrepared(this.prepare(accessToken, boundBaseUrl, verification));
  }

  clear(): boolean {
    return withFileLockSync(this.lockPath, () => {
      if (!fs.existsSync(this.credentialPath)) return false;
      fs.unlinkSync(this.credentialPath);
      return true;
    });
  }

  /** Caller must independently verify the old 127.0.0.1:8123 forwarding belongs to this VM. */
  bindVerifiedLegacyManagedVm(input: Readonly<{
    expectedRevision: string;
    managedVmId: string;
    verifiedLegacyForward: Readonly<{ baseUrl: string; vmId: string }>;
  }>): XiaomiHomeCredentialResolution {
    const vmId = controlledVmId(input.managedVmId);
    if (!input.verifiedLegacyForward || input.verifiedLegacyForward.baseUrl !== "http://127.0.0.1:8123"
      || controlledVmId(input.verifiedLegacyForward.vmId) !== vmId) {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_managed_vm_evidence_invalid", "Verified legacy forwarding ownership is required.");
    }
    return withFileLockSync(this.lockPath, () => {
      if (!fs.existsSync(this.credentialPath)) throw new XiaomiHomeManagerApiError(409, "xiaomi_home_credential_changed", "Credential changed; reload before binding.");
      const content = fs.readFileSync(this.credentialPath, "utf8");
      if (!input.expectedRevision || credentialRevision(content) !== input.expectedRevision) {
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_credential_changed", "Credential changed; reload before binding.");
      }
      const current = this.readProtected()!;
      if (current.metadata?.boundBaseUrl !== "http://127.0.0.1:8123"
        || current.metadata.credentialOrigin === "external"
        || (current.metadata.managedVmId && current.metadata.managedVmId !== vmId)) {
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_managed_vm_mismatch", "Credential is not bound to the verified legacy VM.");
      }
      if (current.metadata.managedVmId === vmId) return current;
      const persisted = JSON.parse(content) as PersistedCredential;
      const updated: PersistedCredential = { ...persisted, managedVmId: vmId, updatedAt: new Date().toISOString() };
      atomicWriteFileSync(this.credentialPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(this.credentialPath, 0o600);
      return this.readProtected()!;
    });
  }

  private readProtected(): XiaomiHomeCredentialResolution | undefined {
    if (!fs.existsSync(this.credentialPath)) return undefined;
    let persisted: PersistedCredential;
    let content: string;
    try {
      content = fs.readFileSync(this.credentialPath, "utf8");
      persisted = JSON.parse(content) as PersistedCredential;
    } catch {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_credential_corrupt", "The protected Xiaomi Home credential file is invalid JSON.");
    }
    if (
      persisted?.schemaVersion !== 1
      || !persisted.protectedCredential
      || !persisted.endpointAccountId
      || !persisted.boundBaseUrl
      || (persisted.managedVmId !== undefined && (typeof persisted.managedVmId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(persisted.managedVmId)))
      || (persisted.credentialOrigin !== undefined && persisted.credentialOrigin !== "external")
      || Boolean(persisted.managedVmId && persisted.credentialOrigin)
      || persisted.protection !== this.protector.scheme
    ) {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_credential_unavailable", "The protected Xiaomi Home credential is unavailable to this system account.");
    }
    try {
      const secret = JSON.parse(this.protector.unprotect(persisted.protectedCredential)) as { accessToken?: unknown };
      const token = controlledToken(secret.accessToken);
      return Object.freeze({
        token,
        source: "protected",
        removable: true,
        metadata: Object.freeze({
          endpointAccountId: persisted.endpointAccountId,
          boundBaseUrl: persisted.boundBaseUrl,
          managedVmId: persisted.managedVmId,
          credentialOrigin: persisted.credentialOrigin,
          revision: credentialRevision(content),
          providerName: persisted.providerName,
          providerVersion: persisted.providerVersion,
          verifiedAt: persisted.verifiedAt,
          updatedAt: persisted.updatedAt
        })
      });
    } catch (error) {
      if (error instanceof XiaomiHomeManagerApiError) throw error;
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_credential_unavailable", "The protected Xiaomi Home credential cannot be decrypted by this system account.");
    }
  }
}

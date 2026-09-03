import { randomUUID } from "node:crypto";
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
  providerName?: string;
  providerVersion?: string;
  verifiedAt: string;
  updatedAt: string;
}>;

export type XiaomiHomeCredentialMetadata = Readonly<{
  endpointAccountId: string;
  boundBaseUrl: string;
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
    verification: Readonly<{ providerName?: string; providerVersion?: string }>
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
    verification: Readonly<{ providerName?: string; providerVersion?: string }>
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

  private readProtected(): XiaomiHomeCredentialResolution | undefined {
    if (!fs.existsSync(this.credentialPath)) return undefined;
    let persisted: PersistedCredential;
    try {
      persisted = JSON.parse(fs.readFileSync(this.credentialPath, "utf8")) as PersistedCredential;
    } catch {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_credential_corrupt", "The protected Xiaomi Home credential file is invalid JSON.");
    }
    if (
      persisted?.schemaVersion !== 1
      || !persisted.protectedCredential
      || !persisted.endpointAccountId
      || !persisted.boundBaseUrl
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

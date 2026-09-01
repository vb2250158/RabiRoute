import type { PersonaSyncFile } from "./personaSync.js";

export type PersonaSyncManifestCacheFile = PersonaSyncFile & {
  mtimeMs: number;
  ctimeMs: number;
  fileId: string;
};

export type PersonaSyncManifestCachePayload = {
  schemaVersion: 1;
  generatedAt: string;
  roles: string[];
  files: PersonaSyncManifestCacheFile[];
};

export type PersonaSyncManifestRefreshRequest = {
  requestId: string;
  rolesRoot: string;
  stateRoot: string;
  /** Fault-injection only. Production callers leave this unset. */
  testDelayMs?: number;
};

export type PersonaSyncManifestRefreshResult = {
  schemaVersion: 1;
  cache: PersonaSyncManifestCachePayload;
  scan: {
    hashedFiles: number;
    reusedFiles: number;
    completedAt: string;
  };
};

export type PersonaSyncManifestRefreshResponse =
  | {
      requestId: string;
      ok: true;
      value: PersonaSyncManifestRefreshResult;
    }
  | {
      requestId: string;
      ok: false;
      message: string;
      stack?: string;
    };

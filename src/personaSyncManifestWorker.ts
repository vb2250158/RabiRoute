import { PersonaSyncService } from "./personaSync.js";
import type {
  PersonaSyncManifestRefreshRequest,
  PersonaSyncManifestRefreshResponse,
  PersonaSyncManifestRefreshResult
} from "./personaSyncManifestWorkerProtocol.js";

async function build(request: PersonaSyncManifestRefreshRequest): Promise<PersonaSyncManifestRefreshResult> {
  if (request.testDelayMs && request.testDelayMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, request.testDelayMs));
  }
  const service = new PersonaSyncService(() => request.rolesRoot, request.stateRoot, {
    readOnly: true,
    watch: false,
    reconcileOnQueryFallback: true,
    scanExecutionMode: "inline"
  });
  try {
    await service.manifest();
    const status = service.manifestIndexStatus();
    return {
      schemaVersion: 1,
      cache: service.manifestCacheSnapshot(),
      scan: {
        hashedFiles: status.totalHashedFiles,
        reusedFiles: status.lastReconcile?.reusedFiles ?? 0,
        completedAt: new Date().toISOString()
      }
    };
  } finally {
    service.stopManifestIndex();
  }
}

function send(message: PersonaSyncManifestRefreshResponse): void {
  if (!process.send) throw new Error("Persona manifest worker requires an IPC channel.");
  process.send(message, error => {
    if (process.connected) process.disconnect();
    process.exit(error ? 1 : 0);
  });
}

if (!process.send || process.env.RABIROUTE_PERSONA_MANIFEST_WORKER !== "1") {
  throw new Error("Persona manifest worker must be launched by its bounded parent client.");
}

process.once("message", raw => {
  const request = raw as PersonaSyncManifestRefreshRequest;
  void build(request).then(
    value => send({ requestId: request.requestId, ok: true, value }),
    error => send({
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
  );
});

process.once("disconnect", () => process.exit(0));

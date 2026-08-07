import { parentPort, workerData } from "node:worker_threads";
import {
  queryPersonaVoiceTranscriptViews,
  type PersonaVoiceTranscriptQuery
} from "../personaVoiceTranscriptView.js";
import { PersonaSyncService } from "../personaSync.js";

export type ManagerReadWorkerTask =
  | {
      type: "persona_voice_transcripts";
      roleDir: string;
      query: PersonaVoiceTranscriptQuery;
    }
  | {
      type: "persona_sync_conflicts";
      rolesRoot: string;
      stateRoot: string;
      roleId?: string;
    };

export type ManagerReadWorkerResponse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string };

async function execute(task: ManagerReadWorkerTask): Promise<unknown> {
  switch (task.type) {
    case "persona_voice_transcripts":
      return queryPersonaVoiceTranscriptViews(task.roleDir, task.query);
    case "persona_sync_conflicts": {
      const service = new PersonaSyncService(() => task.rolesRoot, task.stateRoot);
      return service.listConflictsAsync(task.roleId, {
        pauseEveryEntries: 64,
        pauseMs: 10
      });
    }
  }
}

const workerPort = parentPort;
if (!workerPort) throw new Error("Manager read worker requires a parent port.");

void execute(workerData as ManagerReadWorkerTask)
  .then(value => workerPort.postMessage({ ok: true, value } satisfies ManagerReadWorkerResponse))
  .catch(error => workerPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  } satisfies ManagerReadWorkerResponse));

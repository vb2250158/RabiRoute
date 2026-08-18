import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import {
  queryPersonaVoiceTranscriptViews,
  type PersonaVoiceTranscriptQuery
} from "../personaVoiceTranscriptView.js";
import { PersonaSyncService } from "../personaSync.js";
import {
  scanAgentAdapters,
  type AgentScanOptions,
  type AgentScanRuntimeSnapshot
} from "../agentAdapters/managerApi.js";
import {
  getConsolidatedMemory,
  getRecentMemory,
  listActiveRecentMemories,
  listArchivedMemories,
  listConsolidatedMemories,
  listConsolidationRuns,
  roleMemoryCounts,
  presentRoleMemories
} from "../roleKnowledge.js";
import { paginateRoleMemory } from "../roleKnowledgePagination.js";
import { sortKnowledgeByUpdatedAt } from "../roleKnowledgePresentation.js";
import type {
  PerformanceMonitoringConfig,
  PerformanceSample,
  PerformanceStoreStatus
} from "../shared/performanceContract.js";
import { buildPerformanceSummary, isPerformanceSample } from "./performanceStore.js";

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
    }
  | {
      type: "role_memory_catalog";
      roleDir: string;
      kind: "recent" | "consolidated" | "archived";
      memoryId?: string;
    }
  | {
      type: "role_memory_page";
      roleDir: string;
      kind: "recent" | "consolidated" | "archived";
      cursor: string;
      limit: number;
      query: string;
    }
  | {
      type: "role_memory_overview";
      roleDir: string;
    }
  | {
      type: "role_memory_counts";
      roleDir: string;
    }
  | {
      type: "agent_scan";
      rootDir: string;
      runtimes: AgentScanRuntimeSnapshot[];
      options: AgentScanOptions;
    }
  | {
      type: "performance_summary";
      logDirectory: string;
      rangeMs: number;
      config: PerformanceMonitoringConfig;
      status: PerformanceStoreStatus;
    }
  | {
      type: "performance_logs";
      logDirectory: string;
      limit: number;
      status: PerformanceStoreStatus;
    };

export type ManagerReadWorkerResponse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string };

export type ManagerReadWorkerRequest = {
  requestId: string;
  task: ManagerReadWorkerTask;
};

export type ManagerReadWorkerMessage = ManagerReadWorkerResponse & {
  requestId: string;
};

function performanceShardStart(filename: string): number {
  const match = filename.match(/^performance-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.jsonl$/);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00.000Z`);
}

function parsePerformanceLines(content: string): PerformanceSample[] {
  const samples: PerformanceSample[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isPerformanceSample(value)) samples.push(value);
    } catch {
      // A partially written final line is ignored.
    }
  }
  return samples;
}

async function performanceLogFiles(logDirectory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(logDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && /^performance-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

async function readPerformanceSummarySamples(logDirectory: string, rangeMs: number): Promise<PerformanceSample[]> {
  const safeRangeMs = Math.min(48 * 60 * 60 * 1_000, Math.max(60_000, rangeMs));
  const from = Date.now() - safeRangeMs;
  const filenames = (await performanceLogFiles(logDirectory))
    .filter(filename => performanceShardStart(filename) + 60 * 60 * 1_000 >= from);
  const samples: PerformanceSample[] = [];
  for (const filename of filenames) {
    const content = await fs.promises.readFile(path.join(logDirectory, filename), "utf8");
    for (const sample of parsePerformanceLines(content)) {
      if (Date.parse(sample.time) >= from) samples.push(sample);
    }
  }
  return samples.sort((left, right) => left.time.localeCompare(right.time));
}

async function readRecentPerformanceSamples(logDirectory: string, limit: number): Promise<PerformanceSample[]> {
  const safeLimit = Math.min(1_000, Math.max(1, Math.floor(limit) || 100));
  const filenames = (await performanceLogFiles(logDirectory)).reverse();
  let samples: PerformanceSample[] = [];
  for (const filename of filenames) {
    const content = await fs.promises.readFile(path.join(logDirectory, filename), "utf8");
    samples = [...parsePerformanceLines(content), ...samples];
    if (samples.length >= safeLimit) break;
  }
  return samples
    .sort((left, right) => left.time.localeCompare(right.time))
    .slice(-safeLimit);
}

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
    case "role_memory_catalog": {
      if (task.kind === "recent" || task.kind === "archived") {
        if (task.memoryId && !getRecentMemory(task.roleDir, task.memoryId)) return null;
        const presented = presentRoleMemories(
          task.roleDir,
          sortKnowledgeByUpdatedAt(task.kind === "archived"
            ? listArchivedMemories(task.roleDir)
            : listActiveRecentMemories(task.roleDir)),
          "recent"
        );
        return task.memoryId
          ? presented.find((item) => item.id === task.memoryId) ?? null
          : presented;
      }
      if (task.memoryId && !getConsolidatedMemory(task.roleDir, task.memoryId)) return null;
      const presented = presentRoleMemories(
        task.roleDir,
        sortKnowledgeByUpdatedAt(listConsolidatedMemories(task.roleDir)),
        "consolidated"
      );
      return task.memoryId
        ? presented.find((item) => item.id === task.memoryId) ?? null
        : presented;
    }
    case "role_memory_page": {
      const items = task.kind === "consolidated"
        ? presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listConsolidatedMemories(task.roleDir)), "consolidated")
        : presentRoleMemories(
          task.roleDir,
          sortKnowledgeByUpdatedAt(task.kind === "archived" ? listArchivedMemories(task.roleDir) : listActiveRecentMemories(task.roleDir)),
          "recent"
        );
      return paginateRoleMemory(items, task.cursor, task.limit, task.query, roleMemoryCounts(task.roleDir));
    }
    case "role_memory_overview":
      return {
        recent: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listActiveRecentMemories(task.roleDir)), "recent"),
        consolidated: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listConsolidatedMemories(task.roleDir)), "consolidated"),
        archived: presentRoleMemories(task.roleDir, sortKnowledgeByUpdatedAt(listArchivedMemories(task.roleDir)), "recent"),
        consolidationRuns: listConsolidationRuns(task.roleDir)
      };
    case "role_memory_counts":
      return roleMemoryCounts(task.roleDir);
    case "agent_scan":
      return scanAgentAdapters({ rootDir: task.rootDir, runtimes: task.runtimes }, task.options);
    case "performance_summary": {
      const samples = await readPerformanceSummarySamples(task.logDirectory, task.rangeMs);
      return JSON.stringify({
        code: 0,
        data: buildPerformanceSummary(samples, task.rangeMs, task.config, task.status)
      });
    }
    case "performance_logs": {
      const samples = await readRecentPerformanceSamples(task.logDirectory, task.limit);
      return JSON.stringify({ code: 0, data: samples, status: task.status });
    }
  }
}

function send(message: ManagerReadWorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  if (process.send) {
    process.send(message);
    return;
  }
  throw new Error("Manager read process requires an IPC channel.");
}

async function respond(requestId: string, task: ManagerReadWorkerTask): Promise<void> {
  try {
    const value = await execute(task);
    send({ requestId, ok: true, value } satisfies ManagerReadWorkerMessage);
  } catch (error) {
    send({
      requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    } satisfies ManagerReadWorkerMessage);
  }
}

if (workerData) {
  void respond("one-shot", workerData as ManagerReadWorkerTask);
} else if (parentPort) {
  parentPort.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
} else if (process.send) {
  process.on("message", (request: ManagerReadWorkerRequest) => {
    void respond(request.requestId, request.task);
  });
  process.once("disconnect", () => process.exit(0));
} else {
  throw new Error("Manager read process requires a parent channel.");
}

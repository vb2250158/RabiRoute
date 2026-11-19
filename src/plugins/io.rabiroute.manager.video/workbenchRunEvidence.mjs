import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const legacyStates = {
  succeeded: "pass",
  failed: "fail",
  blocked: "fail",
  skipped: "skip",
  cancelled: "skip",
  waiting_human: "wait",
  waiting_agent: "running",
  running: "running"
};

function logOwner(run, nodeId, attempt, previousRuns) {
  const seen = new Set();
  while (attempt.reusedFromAttemptId) {
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const previous = previousRuns.get(run.resumedFromRunId);
    const previousAttempt = previous?.attempts[nodeId];
    if (previousAttempt?.id !== attempt.reusedFromAttemptId) return;
    run = previous;
    attempt = previousAttempt;
  }
  return { run, attempt };
}

async function appendCommandLogs(logFile, commandAttempts) {
  const stream = createReadStream(logFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      const entry = JSON.parse(line);
      const evidence = commandAttempts.get(entry.attemptId);
      if (evidence && typeof entry.text === "string") evidence.log = (evidence.log + entry.text + "\n").slice(-4000);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function captureLinearRunEvidence(run, logFile, currentNodeId, earlierRuns = []) {
  const nodes = Object.create(null);
  const previousRuns = new Map(earlierRuns.map(item => [item.id, item]));
  const attemptsByLog = new Map();
  for (const node of run.snapshot.graph.nodes) {
    const attempt = run.attempts[node.id];
    const status = legacyStates[attempt?.state];
    const sourceId = node.config.importedNodeId;
    if (!status || !sourceId || node.id === currentNodeId) continue;
    const evidence = { status, detail: attempt.reason, log: "" };
    nodes[sourceId] = evidence;
    if (node.kind !== "command") continue;
    const owner = logOwner(run, node.id, attempt, previousRuns);
    if (!owner) {
      evidence.log = "[WARN] 复用的上游执行缺少可核对的原日志。";
      continue;
    }
    if (!owner.run.sequence) continue;
    const sourceLog = owner.run === run ? logFile : path.join(path.dirname(logFile), `${owner.run.id}.jsonl`);
    const attempts = attemptsByLog.get(sourceLog) ?? new Map();
    attempts.set(owner.attempt.id, evidence);
    attemptsByLog.set(sourceLog, attempts);
  }
  for (const [sourceLog, attempts] of attemptsByLog) await appendCommandLogs(sourceLog, attempts);

  return { status: run.state, date: run.snapshot.variables.find(variable => variable.name === "date")?.value, nodes };
}

export async function prepareLinearRunEvidence(run, logFile, currentNodeId, runtimeRoot, earlierRuns) {
  const evidence = await captureLinearRunEvidence(run, logFile, currentNodeId, earlierRuns);
  const directory = await fs.mkdtemp(path.join(runtimeRoot, "workbench-evidence-"));
  const file = path.join(directory, "linear-run.json");
  const dispose = async () => {
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  };
  try {
    await fs.writeFile(file, JSON.stringify(evidence), { flag: "wx" });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
  return { file, dispose };
}

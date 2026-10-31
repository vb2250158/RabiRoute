import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// An isolated build/query-plan baseline, not the open-loop HTTP capacity gate.
const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!["--work", "--module", "--records", "--queries", "--report", "--index"].includes(key) || !value || values.has(key)) throw new Error("Invalid benchmark argument");
  values.set(key, value);
}
const work = path.resolve(values.get("--work") || "");
const report = path.resolve(values.get("--report") || "");
const modulePath = path.resolve(values.get("--module") || "dist/messageHistorySearchIndex.js");
const count = Number(values.get("--records") || 100_000);
const repetitions = Number(values.get("--queries") || 50);
if (!values.get("--work") || !values.get("--report") || !Number.isSafeInteger(count) || count < 100 || count > 10_000_000
  || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10_000) throw new Error("Explicit work/report and valid record/query counts are required");
if (fs.existsSync(report)) throw new Error("Refusing to overwrite an existing benchmark report");
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Report hardware and timings; priority is best effort. */ }
fs.mkdirSync(work, { recursive: true });
const fixtureFile = path.join(work, "fixture.json");
const role = path.join(work, "synthetic-role");
const progress = value => {
  const event = { at: new Date().toISOString(), pid: process.pid, ...value };
  fs.appendFileSync(path.join(work, "progress.jsonl"), JSON.stringify(event) + "\n");
  process.stdout.write(JSON.stringify(event) + "\n");
};
const record = sequence => {
  const base = "任务处理正常，记录事件和返回结果。".repeat(4);
  const long = sequence % 100_000 === 0 ? "长正文".repeat(80_000) : sequence % 1000 === 0 ? "语音转录".repeat(1000) : base;
  return { schemaVersion: 1, id: `synthetic-${sequence}`, sequence, time: 1767225600 + sequence,
    recordedAt: new Date((1767225600 + sequence) * 1000).toISOString(), direction: sequence % 7 ? "inbound" : "outbound",
    adapter: sequence % 3 ? "synthetic-chat" : "synthetic-device", channel: "synthetic", kind: sequence % 7 ? "group" : "reply_sent",
    sender: `sender-${sequence % 97}`, target: `target-${sequence % 53}`, conversationKey: `conversation-${sequence % 53}`,
    text: `${long} ${sequence % 100 === 0 ? "请求超时" : ""} numeric-${10_000_000 + sequence} tag-${sequence % 9973} %_ quote\" 😀`,
    messageId: String(sequence), ...(sequence % 2000 === 0 ? { attachments: [{ kind: "file", name: "synthetic.txt" }] } : {}) };
};

if (!fs.existsSync(fixtureFile)) {
  if (fs.existsSync(role)) throw new Error("Existing unowned fixture directory; refusing to overwrite it");
  const volume = fs.statfsSync(work);
  if (volume.bavail * volume.bsize < count * 8192 + 1024 ** 3) throw new Error("Insufficient free space for the synthetic source and derived indexes");
  const archive = path.join(role, "conversation", "archive");
  fs.mkdirSync(archive, { recursive: true });
  const archives = [];
  const archivedCount = count - 32;
  progress({ phase: "generate", records: count });
  for (let first = 1; first <= archivedCount; first += 50_000) {
    const last = Math.min(first + 49_999, archivedCount);
    const file = `${first}~${last}.jsonl`;
    const descriptor = fs.openSync(path.join(archive, file), "wx");
    try {
      for (let begin = first; begin <= last; begin += 1000) {
        const rows = [];
        for (let sequence = begin; sequence <= Math.min(begin + 999, last); sequence++) rows.push(JSON.stringify(record(sequence)));
        fs.writeSync(descriptor, rows.join("\n") + "\n");
      }
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    archives.push({ file, firstSequence: first, lastSequence: last, entryCount: last - first + 1,
      startedAt: record(first).recordedAt, endedAt: record(last).recordedAt });
    progress({ phase: "generated-archive", records: last });
  }
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: count + 1, archives }), { flag: "wx" });
  fs.writeFileSync(path.join(role, "conversation", "current.jsonl"), Array.from({ length: 32 }, (_, i) => JSON.stringify(record(archivedCount + i + 1))).join("\n") + "\n", { flag: "wx" });
  fs.writeFileSync(fixtureFile, JSON.stringify({ schemaVersion: 1, records: count, generator: "message-search-v1", synthetic: true }), { flag: "wx" });
} else {
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  if (!fixture.synthetic || fixture.generator !== "message-search-v1" || fixture.records !== count) throw new Error("Fixture ownership/count mismatch");
}

const moduleHash = createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex");
const engine = await import(pathToFileURL(modulePath).href);
const index = path.resolve(work, "derived", values.get("--index") || "search.sqlite");
if (path.dirname(index) !== path.join(work, "derived")) throw new Error("Benchmark index must stay in its owned derived directory");
progress({ phase: "build-start", records: count, moduleHash });
const buildStart = performance.now();
const build = engine.refreshMessageHistoryIndex(role, index);
const buildMs = performance.now() - buildStart;
progress({ phase: "build-complete", records: build.records, buildMs });
const cases = ["10001234", "超时", "任", "任务处理", "tag-9972", "not-present-in-synthetic-source", undefined];
const results = [];
for (const query of cases) {
  const times = []; let returned = 0;
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    returned = engine.searchMessageHistoryIndex(role, { query, includeArchives: true, limit: 10 }, index).length;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const percentile = p => Math.round(times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)] * 100) / 100;
  results.push({ query: query ?? "(latest)", returned, queries: repetitions, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) });
  progress({ phase: "query-case", ...results.at(-1) });
}
const result = { benchmark: "index-build-query-plan-baseline", acceptance: false, node: process.version, platform: process.platform,
  cpu: os.cpus()[0]?.model, cores: os.cpus().length, totalMemory: os.totalmem(), records: count, moduleHash, buildMs, build, results };
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, JSON.stringify(result, null, 2), { flag: "wx" });
progress({ phase: "complete", report, acceptance: false });

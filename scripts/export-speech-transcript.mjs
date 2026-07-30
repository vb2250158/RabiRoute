import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseTime(value, label) {
  const parsed = Date.parse(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp or a local date-time.`);
  }
  return parsed;
}

function recordTime(record) {
  const value = record?.recordedAt ?? record?.startedAt ?? record?.time;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  return Date.parse(String(value ?? ""));
}

function speakerOf(segment) {
  const voiceprint = oneLine(segment?.voiceprintId ?? segment?.voiceprint_id);
  const label = oneLine(
    segment?.speakerLabel
    ?? segment?.speaker_label
    ?? segment?.speaker
  );
  const generic = new Set(["", "voice", "speaker", "unknown", "unknown speaker", "未知"]);
  if (label && !generic.has(label.toLowerCase())) return label;
  if (voiceprint) return voiceprint;
  return label || "未知说话人";
}

function formatTime(timeMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timeMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function entriesForRecord(record) {
  const baseTime = recordTime(record);
  if (!Number.isFinite(baseTime)) return [];
  const segments = Array.isArray(record?.segments)
    ? record.segments.filter(segment => oneLine(segment?.text))
    : [];
  if (segments.length === 0) {
    const text = oneLine(record?.text);
    return text
      ? [{
          recordId: oneLine(record?.id),
          segmentIndex: 0,
          timeMs: baseTime,
          speaker: "未知说话人",
          text
        }]
      : [];
  }
  return segments.map((segment, index) => {
    const offsetSeconds = Number(segment?.start ?? segment?.startSeconds ?? 0);
    return {
      recordId: oneLine(record?.id),
      segmentIndex: index,
      timeMs: baseTime + (Number.isFinite(offsetSeconds) ? Math.max(0, offsetSeconds) * 1_000 : 0),
      speaker: speakerOf(segment),
      text: oneLine(segment.text)
    };
  });
}

function readJsonlRecords(inputDir) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Speech message directory does not exist: ${inputDir}`);
  }
  const files = fs.readdirSync(inputDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
    .map(entry => path.join(inputDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const records = [];
  let invalidLines = 0;
  for (const filePath of files) {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object") records.push(record);
      } catch {
        invalidLines += 1;
      }
    }
  }
  return { files, records, invalidLines };
}

function atomicWrite(filePath, content, force) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  if (!force && fs.existsSync(filePath)) {
    throw new Error(`Output already exists: ${filePath}. Pass --force to replace it.`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx");
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (force && fs.existsSync(filePath)) fs.rmSync(filePath);
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export async function exportSpeechTranscript(options) {
  const inputDir = path.resolve(String(options?.inputDir ?? "data/speech/messages"));
  const outputPath = path.resolve(String(options?.outputPath ?? ""));
  if (!options?.outputPath) throw new Error("outputPath is required.");
  const fromMs = parseTime(options?.from, "from");
  const toMs = parseTime(options?.to, "to");
  if (toMs <= fromMs) throw new Error("to must be later than from.");
  const timeZone = String(
    options?.timeZone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC"
  );
  new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));

  const { files, records, invalidLines } = readJsonlRecords(inputDir);
  const unique = new Map();
  let duplicateRecords = 0;
  for (const record of records) {
    const id = oneLine(record?.id);
    if (!id) continue;
    if (unique.has(id)) {
      duplicateRecords += 1;
      continue;
    }
    unique.set(id, record);
  }
  const entries = [...unique.values()]
    .flatMap(entriesForRecord)
    .filter(entry => entry.timeMs >= fromMs && entry.timeMs < toMs)
    .sort((left, right) => (
      left.timeMs - right.timeMs
      || left.recordId.localeCompare(right.recordId)
      || left.segmentIndex - right.segmentIndex
    ));
  const markdown = entries
    .map(entry => `[${formatTime(entry.timeMs, timeZone)}] ${entry.speaker}：${entry.text}`)
    .join("\n");
  atomicWrite(outputPath, markdown ? `${markdown}\n` : "", options?.force === true);
  return {
    inputDir,
    outputPath,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    timeZone,
    sourceFiles: files.length,
    recordsRead: records.length,
    uniqueRecords: unique.size,
    duplicateRecords,
    invalidLines,
    exportedLines: entries.length
  };
}

function argumentMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--force" || item === "--help" || item === "-h") {
      values[item.replace(/^-+/, "")] = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const [key, inline] = item.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || String(value).startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
  }
  return values;
}

function safeFileTime(value) {
  return new Date(parseTime(value, "time")).toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "");
}

function usage() {
  return [
    "Export the host-wide public ASR store to a Markdown transcript.",
    "",
    "Usage:",
    "  npm run export:speech-transcript -- --from <time> --to <time> [options]",
    "",
    "Options:",
    "  --from <time>       Inclusive start time. ISO timestamps with an offset are recommended.",
    "  --to <time>         Exclusive end time.",
    "  --output <path>     Output .md path.",
    "  --input <dir>       Public ASR JSONL directory (default data/speech/messages).",
    "  --time-zone <iana>  Display timezone (default system timezone).",
    "  --force             Replace an existing output file.",
    "  --help              Show this help."
  ].join("\n");
}

async function main() {
  try {
    const args = argumentMap(process.argv.slice(2));
    if (args.help || args.h) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!args.from || !args.to) throw new Error("--from and --to are required.");
    const outputPath = args.output
      ? path.resolve(args.output)
      : path.resolve(
          "data",
          "speech",
          "exports",
          `transcript-${safeFileTime(args.from)}--${safeFileTime(args.to)}.md`
        );
    const result = await exportSpeechTranscript({
      inputDir: args.input ?? "data/speech/messages",
      outputPath,
      from: args.from,
      to: args.to,
      timeZone: args["time-zone"],
      force: args.force === true
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();

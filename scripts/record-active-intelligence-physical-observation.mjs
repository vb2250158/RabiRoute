import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALL_PHYSICAL_OBSERVATION_CHECK_IDS,
  PHYSICAL_OBSERVATION_CHECKS,
  PHYSICAL_OBSERVATION_KIND,
  PHYSICAL_OBSERVATION_SCHEMA_VERSION,
  emptyPhysicalObservationChecks,
  isPhysicalObservationChecks
} from "./active-intelligence-physical-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "output", "acceptance", "active-intelligence-physical-observation.json");
const CHECK_ID_SET = new Set(ALL_PHYSICAL_OBSERVATION_CHECK_IDS);

function parseArgs(argv) {
  const options = { confirm: [], revoke: [], reset: false, list: false, outputPath: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm") options.confirm.push(String(argv[++index] || ""));
    else if (argument === "--revoke") options.revoke.push(String(argv[++index] || ""));
    else if (argument === "--reset") options.reset = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function validateActions(options) {
  const ids = [...options.confirm, ...options.revoke];
  for (const id of ids) {
    if (!CHECK_ID_SET.has(id)) throw new Error(`Unknown physical observation check: ${id || "<empty>"}`);
  }
  if (options.reset && ids.length > 0) throw new Error("--reset cannot be combined with --confirm or --revoke.");
  if (options.list && (options.reset || ids.length > 0)) throw new Error("--list cannot be combined with mutation options.");
  if (!options.list && !options.reset && ids.length === 0) {
    throw new Error("Provide an explicit --confirm <check-id>, --revoke <check-id>, or --reset action.");
  }
  if (!String(options.outputPath || "").trim()) throw new Error("--output must not be empty.");
}

function environmentIdHash(randomBytes = crypto.randomBytes) {
  return crypto.createHash("sha256").update(randomBytes(32)).digest("hex");
}

function readExisting(target) {
  if (!fs.existsSync(target)) return null;
  const text = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
  const payload = JSON.parse(text);
  const valid = Number(payload?.schemaVersion) === PHYSICAL_OBSERVATION_SCHEMA_VERSION
    && payload?.kind === PHYSICAL_OBSERVATION_KIND
    && payload?.operatorConfirmed === true
    && /^[0-9a-f]{64}$/.test(String(payload?.environmentIdHash || ""))
    && isPhysicalObservationChecks(payload?.checks);
  if (!valid) throw new Error("Existing physical observation file is malformed; use --reset to replace it after review.");
  return payload;
}

function archiveExisting(target, now) {
  if (!fs.existsSync(target)) return "";
  const archiveDirectory = path.join(path.dirname(target), "archive");
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const suffix = now.toISOString().replace(/[:.]/g, "-");
  const extension = path.extname(target);
  const base = path.basename(target, extension);
  let archivePath = path.join(archiveDirectory, `${base}-${suffix}${extension || ".json"}`);
  let attempt = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDirectory, `${base}-${suffix}-${attempt}${extension || ".json"}`);
    attempt += 1;
  }
  fs.copyFileSync(target, archivePath, fs.constants.COPYFILE_EXCL);
  return archivePath;
}

function writeAtomically(target, payload) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { }
    throw error;
  }
}

export function recordPhysicalObservation(rawOptions = {}, dependencies = {}) {
  const options = {
    confirm: [],
    revoke: [],
    reset: false,
    list: false,
    outputPath: DEFAULT_OUTPUT,
    ...rawOptions
  };
  validateActions(options);
  if (options.list) return { listed: true, checks: PHYSICAL_OBSERVATION_CHECKS, outputPath: "", archivePath: "" };

  const now = dependencies.now?.() ?? new Date();
  const target = path.resolve(options.outputPath);
  let existing = null;
  try {
    existing = readExisting(target);
  } catch (error) {
    if (!options.reset) throw error;
  }
  const checks = options.reset ? emptyPhysicalObservationChecks() : {
    ...emptyPhysicalObservationChecks(),
    ...(existing?.checks || {})
  };
  for (const id of options.confirm) checks[id] = true;
  for (const id of options.revoke) checks[id] = false;

  const payload = {
    schemaVersion: PHYSICAL_OBSERVATION_SCHEMA_VERSION,
    kind: PHYSICAL_OBSERVATION_KIND,
    generatedAt: now.toISOString(),
    operatorConfirmed: true,
    environmentIdHash: existing?.environmentIdHash || environmentIdHash(dependencies.randomBytes),
    checks
  };
  const archivePath = archiveExisting(target, now);
  writeAtomically(target, payload);
  return {
    listed: false,
    payload,
    outputPath: target,
    archivePath,
    confirmed: Object.entries(checks).filter(([, value]) => value).map(([id]) => id)
  };
}

function helpText() {
  return [
    "Usage: node scripts/record-active-intelligence-physical-observation.mjs [action]",
    "  --confirm <check-id>  Confirm one observed physical fact; repeat explicitly for additional facts",
    "  --revoke <check-id>   Revoke one previous confirmation",
    "  --reset               Reset every check to false after archiving the old file",
    "  --list                List allowed check IDs without changing files",
    "  --output <json>       Observation path (default output/acceptance/active-intelligence-physical-observation.json)",
    "The command starts no test, polls no device, stores no notes or device identity, and never confirms checks by default."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const result = recordPhysicalObservation(options);
  if (result.listed) {
    process.stdout.write(`${result.checks.map(item => `${item.id} [${item.domain}] - ${item.description}`).join("\n")}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      outputPath: result.outputPath,
      archivePath: result.archivePath || null,
      confirmedChecks: result.confirmed
    }, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}

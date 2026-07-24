import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PHYSICAL_OBSERVATION_KIND,
  PHYSICAL_OBSERVATION_SCHEMA_VERSION,
  REQUIRED_ANDROID_CHECKS,
  REQUIRED_PERSONA_CHECKS,
  REQUIRED_ROKID_CHECKS,
  isPhysicalObservationChecks
} from "./active-intelligence-physical-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_AGE_DAYS = 30;

function parseArgs(argv) {
  const options = {
    speakerDataset: path.join(REPO_ROOT, "plugin-adapters", "rabi-speech", "benchmarks", "private", "speaker-validation", "speaker-cases.json"),
    speakerReport: "",
    personaSync: "",
    mobileSoak: "",
    rokid: "",
    observation: path.join(REPO_ROOT, "output", "acceptance", "active-intelligence-physical-observation.json"),
    outputPath: path.join(REPO_ROOT, "output", "acceptance", "active-intelligence-physical-status.json"),
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    allowIncomplete: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--speaker-dataset") options.speakerDataset = String(argv[++index] || "");
    else if (argument === "--speaker-report") options.speakerReport = String(argv[++index] || "");
    else if (argument === "--persona-sync") options.personaSync = String(argv[++index] || "");
    else if (argument === "--mobile-soak") options.mobileSoak = String(argv[++index] || "");
    else if (argument === "--rokid") options.rokid = String(argv[++index] || "");
    else if (argument === "--observation") options.observation = String(argv[++index] || "");
    else if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--max-age-days") options.maxAgeDays = Number(argv[++index]);
    else if (argument === "--allow-incomplete") options.allowIncomplete = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays <= 0 || options.maxAgeDays > 3650) {
    throw new Error("--max-age-days must be greater than zero and no more than 3650.");
  }
  return options;
}

function filesRecursively(root, predicate) {
  if (!root || !fs.existsSync(root)) return [];
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && predicate(target)) result.push(target);
    }
  };
  visit(root);
  return result;
}

function latestFile(root, predicate) {
  return filesRecursively(root, predicate)
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.file || "";
}

function resolveDefaults(options) {
  return {
    ...options,
    personaSync: options.personaSync || latestFile(
      path.join(REPO_ROOT, "data", "persona-sync", "acceptance"),
      file => /^persona-sync-.*\.json$/i.test(path.basename(file))
    ),
    mobileSoak: options.mobileSoak || latestFile(
      path.join(REPO_ROOT, "apps", "rabilink-android", "out"),
      file => path.basename(file).toLowerCase() === "summary.json" && file.toLowerCase().includes("mobile-audio-soak")
    ),
    rokid: options.rokid || latestFile(
      path.join(REPO_ROOT, "apps", "rabilink-android", "out", "rokid-native-voice"),
      file => /^rokid-native-voice-real-summary-.*\.json$/i.test(path.basename(file))
    )
  };
}

function readEvidence(filePath, label) {
  const value = String(filePath || "").trim();
  if (!value) return { present: false, label };
  const absolute = path.resolve(value);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return { present: false, label };
  const bytes = fs.readFileSync(absolute);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("root must be an object");
    return { present: true, valid: true, label, absolute, sha256, payload };
  } catch (error) {
    return {
      present: true,
      valid: false,
      label,
      absolute,
      sha256,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseEvidenceTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const text = String(value || "").trim();
  if (!text) return NaN;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(text.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"));
}

function freshness(source, generatedAt, nowMs, maxAgeMs) {
  const generatedMs = parseEvidenceTime(generatedAt);
  source.generatedAt = Number.isFinite(generatedMs) ? new Date(generatedMs).toISOString() : null;
  source.fresh = Number.isFinite(generatedMs) && generatedMs <= nowMs + 5 * 60 * 1000 && nowMs - generatedMs <= maxAgeMs;
  return source.fresh;
}

function sourceSummary(evidence, kind, generatedAt, nowMs, maxAgeMs) {
  const source = { kind, sha256: evidence.sha256 };
  freshness(source, generatedAt, nowMs, maxAgeMs);
  return source;
}

function check(id, passed, actual) {
  return { id, passed: Boolean(passed), ...(actual === undefined ? {} : { actual }) };
}

function finishDomain(domain, { invalid = false, stale = false } = {}) {
  const passed = domain.checks.length > 0 && domain.checks.every(item => item.passed);
  domain.state = invalid ? "invalid" : stale ? "stale" : passed ? "passed" : domain.evidence.length ? "partial" : "missing";
  domain.passed = domain.state === "passed";
  return domain;
}

function manualObservation(evidence, nowMs, maxAgeMs) {
  if (!evidence.present) return { checks: {}, evidence: [], invalid: false, stale: false };
  if (!evidence.valid) return { checks: {}, evidence: [], invalid: true, stale: false, issue: "observation_json_invalid" };
  const payload = evidence.payload;
  const source = sourceSummary(evidence, String(payload.kind || "unknown"), payload.generatedAt, nowMs, maxAgeMs);
  const valid = Number(payload.schemaVersion) === PHYSICAL_OBSERVATION_SCHEMA_VERSION
    && payload.kind === PHYSICAL_OBSERVATION_KIND
    && payload.operatorConfirmed === true
    && /^[0-9a-f]{64}$/.test(String(payload.environmentIdHash || ""))
    && isPhysicalObservationChecks(payload.checks);
  return {
    checks: valid ? payload.checks : {},
    evidence: [source],
    invalid: !valid,
    stale: valid && !source.fresh,
    issue: valid ? "" : "observation_contract_invalid"
  };
}

function voiceprintDomain(datasetEvidence, reportEvidence, nowMs, maxAgeMs) {
  const domain = { state: "missing", passed: false, checks: [], issues: [], evidence: [], facts: {} };
  let invalid = false;
  let stale = false;
  if (datasetEvidence.present) {
    domain.checks.push(check("speaker_dataset_present", true));
    domain.evidence.push({ kind: "speaker_validation_dataset", sha256: datasetEvidence.sha256, generatedAt: null, fresh: true });
    if (!datasetEvidence.valid) {
      invalid = true;
      domain.issues.push("speaker_dataset_json_invalid");
    } else {
      const dataset = datasetEvidence.payload;
      const samples = Array.isArray(dataset.samples) ? dataset.samples : [];
      const speakers = new Set(samples.map(item => String(item?.speaker || "")).filter(Boolean));
      domain.facts = { samples: samples.length, speakers: speakers.size };
      domain.checks.push(
        check("dataset_real_person_private", dataset.dataset_kind === "real_person_private"),
        check("dataset_formal_validation_eligible", dataset.formal_validation_eligible === true),
        check("dataset_has_samples", samples.length > 0, samples.length)
      );
    }
  }
  if (reportEvidence.present) {
    domain.checks.push(check("speaker_formal_report_present", true));
    if (!reportEvidence.valid) {
      invalid = true;
      domain.issues.push("speaker_report_json_invalid");
    } else {
      const report = reportEvidence.payload;
      const source = sourceSummary(reportEvidence, "speaker_validation_report", report.generated_at, nowMs, maxAgeMs);
      domain.evidence.push(source);
      stale ||= !source.fresh;
      const results = Array.isArray(report.results) ? report.results : [];
      const enginePassed = results.length > 0 && results.every(item => item?.validation?.passed === true);
      const reportSchemaValid = Number(report.schema_version) === 1;
      domain.checks.push(
        check("report_schema", reportSchemaValid),
        check("report_real_person_private", report.dataset_kind === "real_person_private"),
        check("report_formal_validation_eligible", report.formal_validation_eligible === true),
        check("report_complete_policy_passed", report.validation?.passed === true),
        check("all_reported_engines_passed", enginePassed, results.length)
      );
      if (!reportSchemaValid) {
        invalid = true;
        domain.issues.push("speaker_report_contract_invalid");
      }
      if (datasetEvidence.present && datasetEvidence.valid) {
        domain.checks.push(check("dataset_manifest_hash_matches_report", report.dataset_manifest_sha256 === datasetEvidence.sha256));
      }
      if (report.dataset_kind !== "real_person_private" && report.formal_validation_eligible === true) {
        invalid = true;
        domain.issues.push("synthetic_or_unqualified_dataset_claimed_as_formal");
      }
    }
  }
  if (!datasetEvidence.present) {
    domain.checks.push(check("speaker_dataset_present", false));
    domain.issues.push("speaker_dataset_missing");
  }
  if (!reportEvidence.present) {
    domain.checks.push(check("speaker_formal_report_present", false));
    domain.issues.push("speaker_formal_report_missing");
  }
  return finishDomain(domain, { invalid, stale });
}

function personaDomain(evidence, observation, nowMs, maxAgeMs) {
  const domain = { state: "missing", passed: false, checks: [], issues: [], evidence: [...observation.evidence] };
  let invalid = observation.invalid;
  let stale = observation.stale;
  if (observation.issue) domain.issues.push(observation.issue);
  if (evidence.present) {
    if (!evidence.valid) {
      invalid = true;
      domain.issues.push("persona_sync_json_invalid");
    } else {
      const payload = evidence.payload;
      const source = sourceSummary(evidence, String(payload.kind || "unknown"), payload.generatedAt, nowMs, maxAgeMs);
      domain.evidence.push(source);
      stale ||= !source.fresh;
      const schemaVersion = Number(payload.schemaVersion);
      const contractValid = (schemaVersion === 1 || schemaVersion === 2) && payload.kind === "persona_sync_physical_acceptance";
      const functionalPass = schemaVersion === 2
        ? payload.syncPassed === true && payload.status === "passed"
        : payload.mode === "sync" && payload.acceptancePassed === true && payload.status === "passed";
      domain.checks.push(
        check("persona_sync_evidence_contract", contractValid),
        check("persona_sync_schema_v2", schemaVersion === 2),
        check("persona_sync_mode", payload.mode === "sync"),
        check("persona_sync_functional_pass", functionalPass),
        check("persona_sync_physical_hosts_confirmed", schemaVersion === 2 && payload.physicalHostsConfirmed === true),
        check("persona_sync_formal_acceptance_eligible", schemaVersion === 2 && payload.formalAcceptanceEligible === true && payload.acceptancePassed === true)
      );
      if (!contractValid) {
        invalid = true;
        domain.issues.push("persona_sync_contract_invalid");
      }
    }
  } else {
    domain.issues.push("persona_sync_evidence_missing");
  }
  for (const id of REQUIRED_PERSONA_CHECKS) domain.checks.push(check(id, observation.checks[id] === true));
  return finishDomain(domain, { invalid, stale });
}

function androidDomain(evidence, observation, nowMs, maxAgeMs) {
  const domain = { state: "missing", passed: false, checks: [], issues: [], evidence: [...observation.evidence] };
  let invalid = observation.invalid;
  let stale = observation.stale;
  if (observation.issue) domain.issues.push(observation.issue);
  if (evidence.present) {
    if (!evidence.valid) {
      invalid = true;
      domain.issues.push("mobile_soak_json_invalid");
    } else {
      const payload = evidence.payload;
      const generatedAt = payload.endedAt || payload.generatedAt;
      const source = sourceSummary(evidence, "rabilink_mobile_audio_physical_acceptance", generatedAt, nowMs, maxAgeMs);
      domain.evidence.push(source);
      stale ||= !source.fresh;
      const observedHours = Number(payload.observedDurationHours || 0);
      const contractValid = payload.packageName === "com.rabi.link" && typeof payload.serial === "string" && payload.serial.length > 0;
      domain.checks.push(
        check("mobile_soak_real_device_shape", contractValid),
        check("mobile_soak_passed", payload.passed === true),
        check("mobile_soak_24_hours", observedHours >= 23.5, observedHours),
        check("mobile_pcm_bytes_increased", payload.bytesIncreased === true)
      );
      if (!contractValid) {
        invalid = true;
        domain.issues.push("mobile_soak_contract_invalid");
      }
    }
  } else {
    domain.issues.push("mobile_soak_evidence_missing");
  }
  for (const id of REQUIRED_ANDROID_CHECKS) domain.checks.push(check(id, observation.checks[id] === true));
  return finishDomain(domain, { invalid, stale });
}

function commandNames(commands) {
  return new Set((Array.isArray(commands) ? commands : []).map(item => String(item?.command || item || "").trim().toLowerCase()).filter(Boolean));
}

function rokidDomain(evidence, observation, nowMs, maxAgeMs) {
  const domain = { state: "missing", passed: false, checks: [], issues: [], evidence: [...observation.evidence] };
  let invalid = observation.invalid;
  let stale = observation.stale;
  if (observation.issue) domain.issues.push(observation.issue);
  if (evidence.present) {
    if (!evidence.valid) {
      invalid = true;
      domain.issues.push("rokid_real_device_json_invalid");
    } else {
      const payload = evidence.payload;
      const source = sourceSummary(evidence, "rokid_native_voice_real_device", payload.generatedAt, nowMs, maxAgeMs);
      domain.evidence.push(source);
      stale ||= !source.fresh;
      const commands = commandNames(payload.commands);
      const requestedTts = commands.has("tts");
      const requestedAsr = commands.has("asr_start") || commands.has("start_asr") || commands.has("echo_start") || commands.has("start_echo");
      const contractValid = payload.mode === "real-device-no-injection" && payload.checks && typeof payload.checks === "object";
      domain.checks.push(
        check("rokid_real_device_mode", contractValid),
        check("rokid_script_passed", payload.passed === true),
        check("rokid_tts_was_requested", requestedTts),
        check("rokid_tts_acknowledged", requestedTts && payload.checks?.realTtsAck === true),
        check("rokid_asr_was_requested", requestedAsr),
        check("rokid_asr_text_received", requestedAsr && payload.allowNoAsrText !== true && payload.checks?.asrTextReceived === true),
        check("rokid_no_fatal_exception", payload.checks?.noFatalException === true && payload.checks?.nativeErrorSeen !== true)
      );
      if (!contractValid) {
        invalid = true;
        domain.issues.push("rokid_real_device_contract_invalid");
      }
    }
  } else {
    domain.issues.push("rokid_real_device_evidence_missing");
  }
  for (const id of REQUIRED_ROKID_CHECKS) domain.checks.push(check(id, observation.checks[id] === true));
  return finishDomain(domain, { invalid, stale });
}

function overallState(domains) {
  const values = Object.values(domains);
  if (values.every(domain => domain.state === "passed")) return "passed";
  if (values.some(domain => domain.state === "invalid")) return "invalid";
  if (values.some(domain => domain.state === "stale")) return "stale";
  if (values.every(domain => domain.state === "missing")) return "missing";
  return "partial";
}

function writeReport(outputPath, report) {
  const target = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

export function buildActiveIntelligencePhysicalAcceptance(rawOptions = {}, dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const options = resolveDefaults({
    speakerDataset: "",
    speakerReport: "",
    personaSync: "",
    mobileSoak: "",
    rokid: "",
    observation: "",
    outputPath: "",
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    allowIncomplete: false,
    ...rawOptions
  });
  const nowMs = now.getTime();
  const maxAgeMs = Number(options.maxAgeDays) * 24 * 60 * 60 * 1000;
  const dataset = readEvidence(options.speakerDataset, "speaker_dataset");
  const speakerReport = readEvidence(options.speakerReport, "speaker_report");
  const persona = readEvidence(options.personaSync, "persona_sync");
  const mobile = readEvidence(options.mobileSoak, "mobile_soak");
  const rokid = readEvidence(options.rokid, "rokid");
  const observationEvidence = readEvidence(options.observation, "observation");
  const observation = manualObservation(observationEvidence, nowMs, maxAgeMs);
  const domains = {
    voiceprint: voiceprintDomain(dataset, speakerReport, nowMs, maxAgeMs),
    personaSync: personaDomain(persona, observation, nowMs, maxAgeMs),
    android: androidDomain(mobile, observation, nowMs, maxAgeMs),
    rokid: rokidDomain(rokid, observation, nowMs, maxAgeMs)
  };
  const state = overallState(domains);
  const report = {
    schemaVersion: 1,
    kind: "active_intelligence_physical_acceptance",
    generatedAt: now.toISOString(),
    maxEvidenceAgeDays: Number(options.maxAgeDays),
    overall: {
      state,
      passed: state === "passed",
      passedDomains: Object.values(domains).filter(domain => domain.passed).length,
      totalDomains: Object.keys(domains).length
    },
    domains,
    policy: {
      automatedTestsArePrerequisitesOnly: true,
      syntheticVoiceCannotSatisfyFormalVoiceprint: true,
      missingOrMalformedEvidenceFailsClosed: true,
      outputContainsHashesAndCheckResultsOnly: true
    }
  };
  const outputPath = options.outputPath ? writeReport(options.outputPath, report) : "";
  return { report, outputPath, exitCode: report.overall.passed || options.allowIncomplete ? 0 : 2 };
}

function helpText() {
  return [
    "Usage: node scripts/check-active-intelligence-physical-acceptance.mjs [options]",
    "  --speaker-dataset <json>  Private real-person speaker-cases.json",
    "  --speaker-report <json>   Formal speaker benchmark report",
    "  --persona-sync <json>     Physical persona-sync acceptance report",
    "  --mobile-soak <json>      Android mobile-audio soak summary.json",
    "  --rokid <json>            Rokid real-device summary JSON",
    "  --observation <json>      Operator-confirmed physical observation JSON",
    "  --max-age-days <days>     Evidence freshness window (default 30)",
    "  --output <json>           Sanitized aggregate report path",
    "  --allow-incomplete        Return exit code 0 while still reporting missing/partial state",
    "Default exit code is 2 until every physical domain passes. The command never starts tests or polls devices."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const result = buildActiveIntelligencePhysicalAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    state: result.report.overall.state,
    passed: result.report.overall.passed,
    domains: Object.fromEntries(Object.entries(result.report.domains).map(([key, value]) => [key, value.state])),
    outputPath: result.outputPath
  }, null, 2)}\n`);
  return result.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}

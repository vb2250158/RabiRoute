import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TEXT = "这是一条由文本转语音模型生成的系统测试音频，用来验证语音转写、声纹提取和事件记录链路。";

function parseArgs(argv) {
  const options = {
    speechUrl: "http://127.0.0.1:8781",
    managerUrl: "http://127.0.0.1:8790",
    ttsModel: "auto",
    asrModel: "auto",
    voice: "",
    text: DEFAULT_TEXT,
    ttsLanguage: "",
    asrLanguage: "zh",
    instructions: "自然、清晰、平稳地朗读测试语句。",
    outputPath: "",
    allowApiProvider: false,
    skipManager: false,
    skipVoiceprint: false,
    timeoutMs: 180_000,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--speech") options.speechUrl = String(argv[++index] || "");
    else if (argument === "--manager") options.managerUrl = String(argv[++index] || "");
    else if (argument === "--tts-model") options.ttsModel = String(argv[++index] || "");
    else if (argument === "--asr-model") options.asrModel = String(argv[++index] || "");
    else if (argument === "--voice") options.voice = String(argv[++index] || "");
    else if (argument === "--text") options.text = String(argv[++index] || "");
    else if (argument === "--language") {
      const language = String(argv[++index] || "");
      options.ttsLanguage = language;
      options.asrLanguage = language;
    }
    else if (argument === "--tts-language") options.ttsLanguage = String(argv[++index] || "");
    else if (argument === "--asr-language") options.asrLanguage = String(argv[++index] || "");
    else if (argument === "--instructions") options.instructions = String(argv[++index] || "");
    else if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--timeout-seconds") options.timeoutMs = Math.max(1, Number(argv[++index] || 0)) * 1000;
    else if (argument === "--allow-api-provider") options.allowApiProvider = true;
    else if (argument === "--skip-manager") options.skipManager = true;
    else if (argument === "--skip-voiceprint") options.skipVoiceprint = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function loopbackBaseUrl(value, label) {
  const url = new URL(String(value || ""));
  const host = url.hostname.toLowerCase();
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host) || url.username || url.password) {
    throw new Error(`${label} must use a loopback URL without embedded credentials.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
  return url.origin;
}

function timestamp(value) {
  return value.toISOString().replace(/[:.]/g, "-");
}

function defaultOutputPath(now) {
  return path.join(
    REPO_ROOT,
    "plugin-adapters",
    "rabi-speech",
    "output",
    "acceptance",
    `tts-asr-voiceprint-${timestamp(now)}`,
    "report.json"
  );
}

function atomicWrite(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, value);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}

function atomicWriteJson(filePath, value) {
  return atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function oneShotDeadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not complete before the one-shot deadline.`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function requestJson(fetchImpl, url, init = {}, acceptedStatuses = [200], timeoutMs = 30_000) {
  const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    const contentType = String(response.headers.get("content-type") || "unknown").split(";", 1)[0];
    throw new Error(`${new URL(url).pathname} returned non-JSON (HTTP ${response.status}, content-type ${contentType}).`);
  }
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(String(body?.detail || body?.message || `${new URL(url).pathname} failed with HTTP ${response.status}.`));
  }
  return { status: response.status, body };
}

function providerCapability(capabilities, kind, providerId) {
  const collection = capabilities?.providers?.[kind];
  if (Array.isArray(collection)) return collection.find(value => value?.id === providerId) || null;
  if (collection && typeof collection === "object") return collection[providerId] || null;
  return null;
}

function isLocalProvider(capabilities, kind, row) {
  const provider = providerCapability(capabilities, kind, String(row?.provider || ""));
  if (provider?.local_only === false || provider?.localOnly === false) return false;
  if (provider?.local_only === true || provider?.localOnly === true) return true;
  const transport = String(provider?.transport || row?.transport || "").toLowerCase();
  if (transport.includes("dashscope") || transport.includes("openai") || transport.includes("https-api")) return false;
  return String(row?.provider || "").toLowerCase().startsWith("local") || transport.includes("local-worker");
}

function isAvailableModel(row) {
  return row?.available === true || row?.status === "ready" || (row?.installed === true && row?.enabled !== false);
}

function selectModel(rows, capabilities, kind, requestedId, allowApiProvider) {
  const candidates = (Array.isArray(rows) ? rows : []).filter(row => row?.capability === kind);
  let selected;
  if (requestedId && requestedId !== "auto") {
    selected = candidates.find(row => String(row?.id || "") === requestedId);
    if (!selected) throw new Error(`Requested ${kind.toUpperCase()} model was not discovered: ${requestedId}`);
    if (!isAvailableModel(selected)) throw new Error(`Requested ${kind.toUpperCase()} model is not available: ${requestedId}`);
  } else {
    selected = candidates
      .filter(isAvailableModel)
      .sort((left, right) => {
        const localDifference = Number(!isLocalProvider(capabilities, kind, left)) - Number(!isLocalProvider(capabilities, kind, right));
        if (localDifference !== 0) return localDifference;
        const defaultDifference = Number(!left?.default) - Number(!right?.default);
        return defaultDifference || String(left?.id || "").localeCompare(String(right?.id || ""));
      })[0];
    if (!selected) throw new Error(`No available ${kind.toUpperCase()} model was discovered.`);
  }
  const local = isLocalProvider(capabilities, kind, selected);
  if (!local && !allowApiProvider) {
    throw new Error(
      `${kind.toUpperCase()} model ${selected.id} is an explicitly configured API Provider. `
      + "Re-run with --allow-api-provider to authorize this smoke request."
    );
  }
  return { row: selected, local };
}

function modelDefaultVoice(row) {
  const value = row?.request?.properties?.voice?.default;
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function normalizeTranscript(value) {
  return String(value || "")
    .replace(/^\s*(?:\[[^\]]+\]|[^:\n]{1,24}:)\s*/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function hashValue(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function parseWave(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("TTS response is not a valid RIFF/WAVE file.");
  }
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (id === "fmt " && size >= 16 && payloadOffset + size <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sampleRate: buffer.readUInt32LE(payloadOffset + 4),
        byteRate: buffer.readUInt32LE(payloadOffset + 8),
        blockAlign: buffer.readUInt16LE(payloadOffset + 12),
        bitsPerSample: buffer.readUInt16LE(payloadOffset + 14)
      };
    } else if (id === "data") {
      dataOffset = payloadOffset;
      dataSize = Math.min(size, Math.max(0, buffer.length - payloadOffset));
      break;
    }
    offset = payloadOffset + size + (size % 2);
  }
  if (!format || dataOffset < 0 || !format.blockAlign) throw new Error("WAV is missing a supported fmt/data chunk.");
  const frames = Math.floor(dataSize / format.blockAlign);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let samples = 0;
  const bytesPerSample = Math.floor(format.bitsPerSample / 8);
  for (let offset = dataOffset; offset + bytesPerSample <= dataOffset + dataSize; offset += bytesPerSample) {
    let value;
    if (format.audioFormat === 1 && format.bitsPerSample === 8) value = (buffer.readUInt8(offset) - 128) / 128;
    else if (format.audioFormat === 1 && format.bitsPerSample === 16) value = buffer.readInt16LE(offset) / 32768;
    else if (format.audioFormat === 1 && format.bitsPerSample === 24) {
      let integer = buffer.readUIntLE(offset, 3);
      if (integer & 0x800000) integer -= 0x1000000;
      value = integer / 8388608;
    } else if (format.audioFormat === 1 && format.bitsPerSample === 32) value = buffer.readInt32LE(offset) / 2147483648;
    else if (format.audioFormat === 3 && format.bitsPerSample === 32) value = buffer.readFloatLE(offset);
    else throw new Error(`Unsupported WAV sample encoding: format=${format.audioFormat}, bits=${format.bitsPerSample}`);
    const absolute = Math.abs(value);
    peak = Math.max(peak, absolute);
    sumSquares += value * value;
    if (absolute >= 0.999) clipped += 1;
    samples += 1;
  }
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    frames,
    durationSeconds: frames / format.sampleRate,
    rms: samples ? Math.sqrt(sumSquares / samples) : 0,
    peak,
    clippingRatio: samples ? clipped / samples : 0
  };
}

function sseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = [];
  let start = 0;
  while (true) {
    const end = normalized.indexOf("\n\n", start);
    if (end < 0) break;
    frames.push(normalized.slice(start, end));
    start = end + 2;
  }
  return { frames, remainder: normalized.slice(start) };
}

function parseSseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  let payload = null;
  if (data.length) {
    const text = data.join("\n");
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return { event, data: payload };
}

function startRecordEventObserver(fetchImpl, url, sessionId, timeoutMs) {
  const controller = new AbortController();
  const observed = new Map();
  let readyResolve;
  let readyReject;
  let recordsResolve;
  let recordsReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const recordsPromise = new Promise((resolve, reject) => { recordsResolve = resolve; recordsReject = reject; });
  void readyPromise.catch(() => {});
  void recordsPromise.catch(() => {});
  const run = (async () => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`Speech event stream failed with HTTP ${response.status}.`);
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("text/event-stream")) {
        throw new Error(
          `Speech event endpoint returned ${contentType || "an unknown content type"}; `
          + "the running Manager may not expose the current speech SSE API."
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Speech event stream closed before the expected records_changed events.");
        buffer += decoder.decode(value, { stream: true });
        const parsed = sseFrames(buffer);
        buffer = parsed.remainder;
        for (const rawFrame of parsed.frames) {
          const frame = parseSseFrame(rawFrame);
          if (frame.event === "ready") readyResolve(true);
          if (frame.event !== "records_changed" || frame.data?.session_id !== sessionId) continue;
          const kind = String(frame.data?.kind || "");
          if (kind === "tts" || kind === "asr") observed.set(kind, {
            kind,
            recordIdHash: hashValue(frame.data?.id),
            time: Number(frame.data?.time || 0)
          });
          if (observed.has("tts") && observed.has("asr")) {
            recordsResolve([...observed.values()].sort((left, right) => left.kind.localeCompare(right.kind)));
            return;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      readyReject(error);
      recordsReject(error);
    }
  })();
  return {
    ready: () => oneShotDeadline(readyPromise, Math.min(timeoutMs, 30_000), "Speech SSE readiness"),
    records: () => oneShotDeadline(recordsPromise, timeoutMs, "TTS/ASR records_changed events"),
    close() {
      controller.abort();
      void run.catch(() => {});
    }
  };
}

function voiceprintEvidence(asr) {
  const segments = Array.isArray(asr?.segments) ? asr.segments : [];
  return segments.flatMap(segment => {
    const id = String(segment?.voiceprint_id || segment?.voiceprintId || segment?.speaker_cluster_id || segment?.speakerClusterId || "").trim();
    if (!id) return [];
    return [{
      idHash: hashValue(id),
      decision: String(segment?.speaker_decision || segment?.speakerDecision || ""),
      model: String(segment?.speaker_model || segment?.speakerModel || ""),
      sampleDurationSeconds: Number(segment?.speaker_sample_duration || segment?.speakerSampleDuration || 0)
    }];
  });
}

function recordsFrom(body, manager = false) {
  if (manager) return Array.isArray(body?.data?.records) ? body.data.records : [];
  return Array.isArray(body?.data) ? body.data : [];
}

function recordKinds(records) {
  return [...new Set((Array.isArray(records) ? records : []).map(row => String(row?.kind || "")).filter(Boolean))].sort();
}

function safeAudioReferences(records) {
  return (Array.isArray(records) ? records : [])
    .map(row => String(row?.audioFile || row?.audio_file || "").trim())
    .filter(Boolean)
    .every(value => !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").includes(".."));
}

function addCheck(report, id, passed, actual = undefined) {
  report.checks.push({ id, passed: Boolean(passed), ...(actual === undefined ? {} : { actual }) });
}

function sanitizedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^/\s]+/gi, "<loopback>")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<local-path>");
}

export async function runRabiSpeechTtsLoopAcceptance(options = {}, dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const speechUrl = loopbackBaseUrl(options.speechUrl || "http://127.0.0.1:8781", "RabiSpeech URL");
  const skipManager = Boolean(options.skipManager);
  const managerUrl = skipManager ? "" : loopbackBaseUrl(options.managerUrl || "http://127.0.0.1:8790", "Manager URL");
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || 180_000));
  const sessionId = `tts-loop-${timestamp(now)}`;
  const outputPath = path.resolve(options.outputPath || defaultOutputPath(now));
  const wavPath = path.join(path.dirname(outputPath), "tts-smoke.wav");
  const text = String(options.text || DEFAULT_TEXT).trim();
  if (!text) throw new Error("Smoke text must not be empty.");
  const report = {
    schemaVersion: 1,
    kind: "rabispeech_tts_asr_voiceprint_acceptance",
    generatedAt: now.toISOString(),
    datasetKind: "synthetic_tts_smoke",
    formalValidationEligible: false,
    sessionId,
    status: "starting",
    acceptancePassed: false,
    routeDeliveryAttempted: false,
    playbackRequested: false,
    managerQueryRequired: !skipManager,
    voiceprintRequired: !options.skipVoiceprint,
    input: {
      textSha256: hashValue(text),
      characters: [...text].length,
      ttsLanguage: String(options.ttsLanguage || "auto"),
      asrLanguage: String(options.asrLanguage || "zh"),
      instructionsConfigured: Boolean(String(options.instructions || "").trim())
    },
    checks: []
  };
  let observer = null;
  let exitCode = 1;
  try {
    const [healthResponse, modelsResponse, capabilitiesResponse] = await Promise.all([
      requestJson(fetchImpl, `${speechUrl}/health`, {}, [200], timeoutMs),
      requestJson(fetchImpl, `${speechUrl}/v1/models`, {}, [200], timeoutMs),
      requestJson(fetchImpl, `${speechUrl}/v1/capabilities`, {}, [200], timeoutMs)
    ]);
    const rows = Array.isArray(modelsResponse.body?.data) ? modelsResponse.body.data : [];
    const capabilities = capabilitiesResponse.body || {};
    const tts = selectModel(rows, capabilities, "tts", String(options.ttsModel || "auto"), Boolean(options.allowApiProvider));
    const asr = selectModel(rows, capabilities, "asr", String(options.asrModel || "auto"), Boolean(options.allowApiProvider));
    const voice = String(options.voice || modelDefaultVoice(tts.row));
    report.service = {
      healthy: healthResponse.status === 200,
      modelCount: rows.length
    };
    report.tts = {
      provider: String(tts.row?.provider || ""),
      model: String(tts.row?.model || tts.row?.id || ""),
      modelId: String(tts.row?.id || ""),
      localProvider: tts.local,
      voiceSource: options.voice ? "explicit" : "model_default"
    };
    report.asr = {
      provider: String(asr.row?.provider || ""),
      model: String(asr.row?.model || asr.row?.id || ""),
      modelId: String(asr.row?.id || ""),
      localProvider: asr.local
    };
    const voiceprint = capabilities?.speaker_identity?.voiceprint || capabilities?.speakerIdentity?.voiceprint || {};
    report.voiceprint = {
      available: Boolean(voiceprint?.available),
      supported: Boolean(voiceprint?.supported),
      validated: Boolean(voiceprint?.validated),
      experimentalAutoAssign: Boolean(voiceprint?.experimental_auto_assign || voiceprint?.experimentalAutoAssign),
      model: String(voiceprint?.model || "")
    };
    addCheck(report, "service_health", report.service.healthy);
    addCheck(report, "tts_model_available", isAvailableModel(tts.row), report.tts.modelId);
    addCheck(report, "asr_model_available", isAvailableModel(asr.row), report.asr.modelId);

    const eventUrl = skipManager ? `${speechUrl}/v1/events` : `${managerUrl}/api/speech/events`;
    observer = startRecordEventObserver(fetchImpl, eventUrl, sessionId, timeoutMs);
    await observer.ready();
    addCheck(report, "event_stream_ready", true);

    const ttsResponse = await fetchImpl(`${speechUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        model: report.tts.modelId,
        input: text,
        voice,
        language: String(options.ttsLanguage || "") || null,
        instructions: String(options.instructions || "") || null,
        response_format: "wav",
        sample_rate: 16_000,
        speed: 1,
        play: false,
        session_id: sessionId
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      let detail = "";
      try {
        const errorBody = errorText ? JSON.parse(errorText) : {};
        detail = String(errorBody?.detail || errorBody?.message || "");
      } catch { /* keep the public status-only error */ }
      throw new Error(`TTS request failed with HTTP ${ttsResponse.status}${detail ? `: ${detail}` : ""}.`);
    }
    const wav = Buffer.from(await ttsResponse.arrayBuffer());
    const audio = parseWave(wav);
    atomicWrite(wavPath, wav);
    report.audio = {
      file: path.basename(wavPath),
      bytes: wav.length,
      ...audio
    };
    addCheck(report, "tts_wav_created", wav.length > 44, wav.length);
    addCheck(report, "audio_16khz_mono", audio.sampleRate === 16_000 && audio.channels === 1, `${audio.sampleRate}Hz/${audio.channels}ch`);
    addCheck(report, "audio_nonempty", audio.durationSeconds >= 1 && audio.rms > 0, Number(audio.durationSeconds.toFixed(3)));
    addCheck(report, "audio_not_clipped", audio.clippingRatio < 0.01, Number(audio.clippingRatio.toFixed(6)));

    const form = new FormData();
    form.set("file", new Blob([wav], { type: "audio/wav" }), "tts-smoke.wav");
    form.set("model", report.asr.modelId);
    form.set("language", report.input.asrLanguage);
    form.set("response_format", "verbose_json");
    form.set("speaker_count", "1");
    form.set("session_id", sessionId);
    const asrResponse = await requestJson(fetchImpl, `${speechUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form
    }, [200], timeoutMs);
    const transcript = String(asrResponse.body?.text || "");
    const expectedNormalized = normalizeTranscript(text);
    const actualNormalized = normalizeTranscript(transcript);
    const transcriptMatched = Boolean(expectedNormalized && actualNormalized && (
      actualNormalized.includes(expectedNormalized) || expectedNormalized.includes(actualNormalized)
    ));
    const evidence = voiceprintEvidence(asrResponse.body);
    report.asr.transcriptSha256 = hashValue(transcript);
    report.asr.transcriptCharacters = [...transcript].length;
    report.asr.transcriptMatched = transcriptMatched;
    report.asr.durationSeconds = Number(asrResponse.body?.duration || 0);
    report.asr.segmentCount = Array.isArray(asrResponse.body?.segments) ? asrResponse.body.segments.length : 0;
    report.voiceprint.evidenceCount = evidence.length;
    report.voiceprint.decisions = [...new Set(evidence.map(item => item.decision).filter(Boolean))].sort();
    report.voiceprint.idHashes = [...new Set(evidence.map(item => item.idHash))].sort();
    addCheck(report, "asr_transcript_nonempty", Boolean(actualNormalized), report.asr.transcriptCharacters);
    addCheck(report, "asr_transcript_matches", transcriptMatched);
    addCheck(report, "asr_segments_present", report.asr.segmentCount > 0, report.asr.segmentCount);
    if (!options.skipVoiceprint) addCheck(report, "voiceprint_evidence_present", evidence.length > 0, evidence.length);

    report.events = await observer.records();
    addCheck(report, "records_changed_tts_and_asr", recordKinds(report.events).join(",") === "asr,tts", recordKinds(report.events));

    const localRecordsResponse = await requestJson(
      fetchImpl,
      `${speechUrl}/v1/records?session_id=${encodeURIComponent(sessionId)}&limit=20`,
      {},
      [200],
      timeoutMs
    );
    const localRecords = recordsFrom(localRecordsResponse.body);
    report.records = {
      rabispeechCount: localRecords.length,
      rabispeechKinds: recordKinds(localRecords),
      managerCount: 0,
      managerKinds: [],
      safeAudioReferences: safeAudioReferences(localRecords)
    };
    addCheck(report, "rabispeech_records_query", report.records.rabispeechKinds.join(",") === "asr,tts", report.records.rabispeechKinds);
    addCheck(report, "safe_audio_references", report.records.safeAudioReferences);

    if (!skipManager) {
      const [managerStatus, managerRecordsResponse] = await Promise.all([
        requestJson(fetchImpl, `${managerUrl}/api/speech/status`, {}, [200], timeoutMs),
        requestJson(
          fetchImpl,
          `${managerUrl}/api/speech/records?sessionId=${encodeURIComponent(sessionId)}&limit=20`,
          {},
          [200],
          timeoutMs
        )
      ]);
      const managerRecords = recordsFrom(managerRecordsResponse.body, true);
      report.manager = {
        state: String(managerStatus.body?.data?.state || ""),
        service: String(managerStatus.body?.data?.service || "")
      };
      report.records.managerCount = managerRecords.length;
      report.records.managerKinds = recordKinds(managerRecords);
      report.records.safeAudioReferences = report.records.safeAudioReferences && safeAudioReferences(managerRecords);
      addCheck(report, "manager_speech_online", report.manager.state === "online", report.manager.state);
      addCheck(report, "manager_records_query", report.records.managerKinds.join(",") === "asr,tts", report.records.managerKinds);
      addCheck(report, "manager_safe_audio_references", safeAudioReferences(managerRecords));
    }

    report.acceptancePassed = report.checks.every(check => check.passed);
    report.status = report.acceptancePassed ? "passed" : "checks_failed";
    exitCode = report.acceptancePassed ? 0 : 2;
  } catch (error) {
    report.status = "failed";
    report.error = sanitizedError(error);
    exitCode = 1;
  } finally {
    if (observer) await observer.close();
  }
  report.exitCode = exitCode;
  report.limitations = [
    "Synthetic TTS is mechanism evidence, not real-person speaker calibration.",
    "This report must not be used as speaker_recognition.validation_report_path.",
    "This run never calls /api/speech/messages, never delivers to a Route, and never enables playback.",
    "API Providers are used only when --allow-api-provider is explicitly supplied."
  ];
  const evidencePath = atomicWriteJson(outputPath, report);
  return { report, evidencePath, wavPath: fs.existsSync(wavPath) ? wavPath : "", exitCode };
}

function helpText() {
  return [
    "Usage: node scripts/test-rabispeech-tts-loop.mjs [options]",
    "  --speech <loopback-url>     RabiSpeech URL (default http://127.0.0.1:8781)",
    "  --manager <loopback-url>    Manager URL (default http://127.0.0.1:8790)",
    "  --tts-model <id|auto>       Discovered TTS model; auto prefers an available local model",
    "  --asr-model <id|auto>       Discovered ASR model; auto prefers an available local model",
    "  --voice <voice-or-role>     Optional voice/persona selector; omitted from evidence",
    "  --text <test-text>          Optional private smoke text; evidence stores hashes only",
    "  --tts-language <value>      Optional TTS language; omitted means provider Auto",
    "  --asr-language <code>       ASR language hint (default zh)",
    "  --language <value>          Compatibility alias that sets both language fields",
    "  --instructions <text>       Optional TTS speaking instruction; omitted from evidence",
    "  --allow-api-provider        Explicitly authorize discovered non-local TTS/ASR providers",
    "  --skip-manager              Observe/query RabiSpeech directly without Manager proxy checks",
    "  --skip-voiceprint           Do not require voiceprint evidence",
    "  --timeout-seconds <n>       One-shot request/event deadline (default 180)",
    "  --output <report.json>      Local ignored evidence path",
    "The script expects already-running services, subscribes to SSE before synthesis, never polls,",
    "never starts/stops the microphone, never plays audio, and never posts to a Route."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const result = await runRabiSpeechTtsLoopAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    acceptancePassed: result.report.acceptancePassed,
    ttsModel: result.report.tts?.modelId || "",
    asrModel: result.report.asr?.modelId || "",
    evidencePath: result.evidencePath,
    wavPath: result.wavPath
  }, null, 2)}\n`);
  return result.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main().catch(error => {
    process.stderr.write(`${sanitizedError(error)}\n`);
    return 1;
  });
}

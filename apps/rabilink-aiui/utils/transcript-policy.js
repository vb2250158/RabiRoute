const DEFAULT_DUPLICATE_WINDOW_MS = 2500;
const DEFAULT_PLAYBACK_ECHO_WINDOW_MS = 12000;
const DEFAULT_PLAYBACK_ECHO_SIMILARITY = 0.92;
const DEFAULT_HISTORY_LIMIT = 12;

export const TRANSCRIPT_POLICY_VERSION = "fennenote-text-v1";

export function normalizeTranscriptText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function transcriptFingerprint(value) {
  return normalizeTranscriptText(value)
    .toLowerCase()
    .replace(/[\s\u3000_\-—–.,!?;:'"`~，。！？；：、“”‘’（）()【】\[\]{}<>《》/\\|]+/g, "");
}

function bigramCounts(value) {
  const counts = new Map();
  if (value.length < 2) return counts;
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    counts.set(gram, Number(counts.get(gram) || 0) + 1);
  }
  return counts;
}

export function transcriptSimilarity(left, right) {
  const a = transcriptFingerprint(left);
  const b = transcriptFingerprint(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  const containment = longer.includes(shorter) ? shorter.length / longer.length : 0;
  const aCounts = bigramCounts(a);
  const bCounts = bigramCounts(b);
  if (!aCounts.size || !bCounts.size) return containment;

  let overlap = 0;
  for (const [gram, count] of aCounts.entries()) {
    overlap += Math.min(count, Number(bCounts.get(gram) || 0));
  }
  const dice = (2 * overlap) / ((a.length - 1) + (b.length - 1));
  return Math.max(containment, dice);
}

function hasTranscriptContent(value) {
  return /[0-9A-Za-z\u3400-\u9fff]/.test(value);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

export function createTranscriptPolicy(options = {}) {
  const duplicateWindowMs = boundedNumber(
    options.duplicateWindowMs,
    DEFAULT_DUPLICATE_WINDOW_MS,
    0,
    30000
  );
  const playbackEchoWindowMs = boundedNumber(
    options.playbackEchoWindowMs,
    DEFAULT_PLAYBACK_ECHO_WINDOW_MS,
    0,
    60000
  );
  const playbackEchoSimilarity = boundedNumber(
    options.playbackEchoSimilarity,
    DEFAULT_PLAYBACK_ECHO_SIMILARITY,
    0.5,
    1
  );
  const historyLimit = Math.round(boundedNumber(
    options.historyLimit,
    DEFAULT_HISTORY_LIMIT,
    2,
    100
  ));
  const accepted = [];
  const played = [];

  const prune = (now) => {
    const acceptedCutoff = now - Math.max(duplicateWindowMs, 1);
    while (accepted.length && accepted[0].at < acceptedCutoff) accepted.shift();
    const playbackCutoff = now - Math.max(playbackEchoWindowMs, 1);
    while (played.length && played[0].at < playbackCutoff) played.shift();
    if (accepted.length > historyLimit) accepted.splice(0, accepted.length - historyLimit);
    if (played.length > historyLimit) played.splice(0, played.length - historyLimit);
  };

  const rememberAccepted = (text, at = Date.now()) => {
    const normalized = normalizeTranscriptText(text);
    const fingerprint = transcriptFingerprint(normalized);
    if (!fingerprint) return;
    accepted.push({ text: normalized, fingerprint, at: Number(at || Date.now()) });
    prune(Number(at || Date.now()));
  };

  const rememberPlayback = (text, at = Date.now()) => {
    const normalized = normalizeTranscriptText(text);
    const fingerprint = transcriptFingerprint(normalized);
    if (fingerprint.length < 4) return;
    played.push({ text: normalized, fingerprint, at: Number(at || Date.now()) });
    prune(Number(at || Date.now()));
  };

  return {
    version: TRANSCRIPT_POLICY_VERSION,

    seedAccepted(segments = []) {
      const rows = Array.isArray(segments) ? segments.slice(-historyLimit) : [];
      for (const segment of rows) {
        const text = typeof segment === "string" ? segment : segment?.text;
        const at = typeof segment === "string" ? Date.now() : Number(segment?.createdAt || Date.now());
        rememberAccepted(text, at);
      }
    },

    rememberPlayback,

    evaluate(value, now = Date.now()) {
      const at = Number(now || Date.now());
      const text = normalizeTranscriptText(value);
      const fingerprint = transcriptFingerprint(text);
      prune(at);

      if (!text || !fingerprint || !hasTranscriptContent(text)) {
        return { accepted: false, text, reason: "empty-or-punctuation" };
      }

      if (duplicateWindowMs > 0) {
        const duplicate = [...accepted].reverse().find((item) => {
          return at - item.at <= duplicateWindowMs && item.fingerprint === fingerprint;
        });
        if (duplicate) {
          return { accepted: false, text, reason: "rapid-duplicate", matchedText: duplicate.text };
        }
      }

      if (playbackEchoWindowMs > 0 && fingerprint.length >= 4) {
        const echo = [...played].reverse().find((item) => {
          return at - item.at <= playbackEchoWindowMs
            && transcriptSimilarity(text, item.text) >= playbackEchoSimilarity;
        });
        if (echo) {
          return { accepted: false, text, reason: "recent-playback-echo", matchedText: echo.text };
        }
      }

      rememberAccepted(text, at);
      return { accepted: true, text, reason: "accepted" };
    }
  };
}

const echoTailMs = 2500;
const recentSegmentLimit = 4;
const referenceLimit = 640;
const minimumFinalSubstringLength = 4;

function normalizedSpeech(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/** Filter high-confidence text repeats from this desktop player's acoustic feedback. */
export function createPlaybackEchoFilter(now = () => performance.now()) {
  let active, recent = [];
  return {
    observe(event) {
      const {type, id, responseId, text} = event;
      if (type === 'play-requested') {
        active = {id, responseId, text: normalizedSpeech(text).slice(0, referenceLimit)};
      } else if (active && active.id === id) {
        if (type === 'cue') {
          const end = event.cue.charIndex + event.cue.charLength - event.textOffset;
          if (end > 0) active.text = normalizedSpeech(text.slice(0, end)).slice(-referenceLimit);
        } else if (type === 'ended' || type === 'cancelled' || type === 'error') {
          const spoken = type === 'ended' ? normalizedSpeech(text).slice(-referenceLimit) : active.text;
          if (spoken) recent = [...recent.slice(1 - recentSegmentLimit), {responseId, text: spoken, expires: now() + echoTailMs}];
          active = undefined;
        }
      }
    },
    acceptTranscript(text, phase) {
      const candidate = normalizedSpeech(text);
      if (!candidate) return true;
      const time = now();
      recent = recent.filter(segment => segment.expires > time);
      const segments = active ? [...recent, active] : recent;
      // Short final words often represent real commands. Only suppress a
      // complete repeat of a playback segment, and keep single-character commands.
      if (phase === 'final' && candidate.length < minimumFinalSubstringLength) {
        return candidate.length < 2 || !segments.some(segment => segment.text === candidate);
      }
      const references = new Map();
      for (const segment of segments) {
        const previous = references.get(segment.responseId) ?? '';
        references.set(segment.responseId, previous + segment.text);
      }
      return ![...references.values()].some(reference => reference.includes(candidate));
    },
    clear() { active = undefined; recent = []; },
  };
}

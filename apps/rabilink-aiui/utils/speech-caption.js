// The only timing input is the native player's active cue. No model-token clock.
export function speechCaption(text, cue) {
  const word = typeof cue?.text === 'string' ? cue.text : '';
  const start = cue?.charIndex, length = cue?.charLength;
  if (Number.isInteger(start) && Number.isInteger(length) && start >= 0 && length > 0
    && start + length <= text.length && text.slice(start, start + length) === word) {
    const chars = Array.from(text), cueIndex = Array.from(text.slice(0, start)).length;
    const first = Math.max(0, Math.min(cueIndex - 8, chars.length - 24));
    const visible = chars.slice(first, first + 24).join('');
    const offset = start - chars.slice(0, first).join('').length;
    return { playbackCaptionText: visible, playbackCaptionStart: offset,
      playbackCaptionLength: Math.min(length, visible.length - offset) };
  }
  // Older runtimes expose cue text without character offsets. Highlight only
  // that real cue rather than guessing which repeated word is being played.
  const visible = Array.from(word || text).slice(0, 24).join('');
  return { playbackCaptionText: visible, playbackCaptionStart: 0, playbackCaptionLength: word ? visible.length : 0 };
}

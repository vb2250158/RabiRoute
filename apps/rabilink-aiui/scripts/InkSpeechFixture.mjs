// Visual/lifecycle fixture for Ink >= 0.19.1. Tests still inject explicitly marked
// recognition results; synthetic browser media merely exercises stream startup.
export function streamSpeechFixture(callbacks) {
  return {
    ...callbacks,
    getRecognitionCapabilities() {
      return { audioFormats: [{ mimeType: 'audio/pcm', sampleRates: [16000], channelCounts: [1], sampleFormats: ['s16'] }], maxChunkBytes: 16384, interimResults: true, maxAlternatives: 1, phrases: false, contextUpdates: false, segmentationModes: ['auto'] };
    },
    openRecognitionStream(request) { return callbacks.startRecognition(request); },
    writeRecognitionAudio() {},
    finishRecognitionStream(request) { return callbacks.stopRecognition(request); },
    abortRecognitionStream(request) { return callbacks.abortRecognition(request); }
  };
}

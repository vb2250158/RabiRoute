import openaiCatalog from './openai-speech-catalog.json' with { type: 'json' };

export const asrDictionaryMaxLength = 16384;

export function dictionaryTerms(value) {
  const seen = new Set();
  return typeof value === 'string' ? value.split(/\r\n?|\n/).flatMap(line => {
    const term = line.trim();
    const key = term.normalize('NFKC').toLowerCase();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [term];
  }) : [];
}

function isEndpoint(value, origins) {
  try { return origins.includes(new URL(value).origin); }
  catch { return false; }
}

export function asrDictionaryPolicy(config) {
  if (config.asrMode === 'volcengine' &&
      isEndpoint(config.asrEndpoint, ['wss://openspeech.bytedance.com'])) {
    const path = new URL(config.asrEndpoint).pathname;
    if (path === '/api/v3/sauc/bigmodel_nostream') return { format: 'hotwords', mode: 'utterance' };
    if (['/api/v3/sauc/bigmodel_async','/api/v3/sauc/bigmodel'].includes(path)) {
      return { format: 'hotwords', mode: config.asrRecognitionMode === 'twopass' ? 'twopass' : 'realtime' };
    }
  }
  if (config.asrMode === 'compatible' && isEndpoint(config.asrEndpoint, openaiCatalog.asr.origins) &&
      new URL(config.asrEndpoint).pathname === '/v1/audio/transcriptions' &&
      openaiCatalog.asr.parameters.find(field => field.key === 'asrPrompt').models.includes(config.asrModel)) {
    return { format: 'prompt', mode: 'utterance' };
  }
  if (config.asrMode === 'local-whisper') return { format: 'prompt', mode: 'utterance', local: true };
  return null;
}

/** Bound provider projections without cutting a phrase in half. */
export function boundedDictionary(value, { maxTerms = Infinity, maxBytes, separator = '\n' }) {
  const terms = [];
  let bytes = 0;
  for (const term of dictionaryTerms(value)) {
    const cost = Buffer.byteLength(term) + (terms.length ? Buffer.byteLength(separator) : 0);
    if (cost + bytes > maxBytes) continue;
    terms.push(term);
    bytes += cost;
    if (terms.length === maxTerms) break;
  }
  return terms;
}

export function volcanoDictionary(config) {
  const policy = asrDictionaryPolicy(config);
  if (policy?.format !== 'hotwords') return [];
  // SAUC accepts 100 tokens on bidirectional input and limits terms on one-way input.
  // The service owns tokenization. Bound our request in bytes as well as terms.
  const limits = policy.mode === 'utterance' ? { maxTerms: 5000, maxBytes: 8192 } : { maxTerms: 30, maxBytes: 300 };
  return boundedDictionary(config.asrDictionary, limits).map(word => ({ word }));
}

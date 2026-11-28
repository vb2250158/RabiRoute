import { speechProviders, validateProviderEndpoint } from '@rabilink/desktop-voice-service/provider-profiles';
import { modelProviders, validateModelEndpoint } from '@rabilink/desktop-voice-service/model-providers';
import { webSearchProviders } from '@rabilink/desktop-voice-service/web-search-catalog';
import { speechSelectionDefinitions, volcanoCatalog } from '@rabilink/desktop-voice-service/speech-catalog';

const generic = { id: 'http-api', label: 'HTTP API', defaults: {} };
const providers = {
  llm: modelProviders.map(({ id, label, endpoint, credentialMode }) => ({ id, label, credentialMode, defaults: { endpoint } })),
  asr: speechProviders.asr.filter(provider => provider.id !== 'native').map(provider=>provider.id==='volcengine'
    ? {...provider, modes:volcanoCatalog.asr.modes, defaults:{...provider.defaults,recognitionMode:speechSelectionDefinitions.asrRecognitionMode.default}}
    : provider),
  tts: speechProviders.tts,
  search: webSearchProviders.map(({ id, label, endpoint }) => ({ id, label, defaults: { endpoint }, ...(endpoint ? {} : { credentialMode: 'local' }) })),
  speaker: [generic], image: [generic], video: [generic],
};

export const assistantServiceKinds = ['llm', 'search', 'asr', 'tts'];
export const defaultModelServiceId = kind => `saved-${kind}`;
export const modelServiceCredentialKey = id => `model-service:${id}`;
export const modelServiceIdField = kind => `${kind}ServiceId`;

export function modelServiceDefinitions() { return structuredClone(providers); }

export function legacyModelServices(settings, hasSearchKey = false) {
  const rows = [];
  for (const kind of assistantServiceKinds) {
    const provider = kind === 'llm' ? settings.llmProvider : kind === 'asr' ? settings.asrMode : kind === 'tts' ? settings.ttsProvider : settings.webSearchProvider;
    const definition = providers[kind].find(item => item.id === provider);
    const model = settings[`${kind}Model`] || '';
    if (!definition || kind !== 'search' && !model) continue;
    rows.push({ id: defaultModelServiceId(kind), kind, provider, name: definition.label,
      endpoint: kind === 'search' ? definition.defaults.endpoint || '' : settings[`${kind}Endpoint`], model,
      ...(kind === 'asr' ? { resourceId: settings.asrResourceId, recognitionMode: settings.asrRecognitionMode } : {}),
      ...(kind === 'tts' ? { resourceId: settings.ttsResourceId, voice: settings.ttsVoice } : {}),
    });
  }
  for (const kind of ['llm','asr','tts']) {
    const active = rows.find(row => row.kind === kind)?.provider;
    const profiles = kind === 'llm' ? settings.llmProfiles : settings.speechProfiles?.[kind];
    for (const definition of providers[kind]) {
      const saved=profiles?.[definition.id];
      if (definition.id === active || !saved?.endpoint || !saved.model) continue;
      rows.push({id:`${defaultModelServiceId(kind)}-${definition.id}`,kind,provider:definition.id,name:definition.label,endpoint:saved.endpoint,model:saved.model,
        ...(kind==='asr'?{resourceId:saved.resourceId,recognitionMode:saved.asrRecognitionMode||speechSelectionDefinitions.asrRecognitionMode.default}:{}),
        ...(kind==='tts'?{resourceId:saved.resourceId,voice:saved.voice}:{})});
    }
  }
  if (hasSearchKey && settings.webSearchProvider !== 'tavily') {
    const definition = providers.search.find(item => item.id === 'tavily');
    rows.push({id:'saved-search-tavily',kind:'search',provider:definition.id,name:definition.label,endpoint:definition.defaults.endpoint,model:''});
  }
  return rows;
}

function field(request, name, max, required = false) {
  const value = request[name] ?? '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || required && !value.trim()) throw Error('MODEL_SERVICE_INVALID');
  return value.trim();
}

export function validateModelService(request, id) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('MODEL_SERVICE_INVALID');
  const kind = field(request, 'kind', 20, true);
  const provider = field(request, 'provider', 40, true);
  const definition = Object.hasOwn(providers, kind) && providers[kind].find(item => item.id === provider);
  if (!definition) throw Error('MODEL_SERVICE_PROVIDER_INVALID');
  const name = field(request, 'name', 128, true);
  const configuredEndpoint = field(request, 'endpoint', 2048);
  const endpoint = kind === 'search' ? definition.defaults.endpoint || '' : kind === 'llm'
    ? validateModelEndpoint(configuredEndpoint, provider) : validateProviderEndpoint(configuredEndpoint, provider);
  const model = field(request, 'model', 256, kind !== 'search');
  const row = { id, kind, provider, name, endpoint, model };
  if (provider === 'volcengine') row.resourceId = field(request, 'resourceId', 256, true);
  if (kind === 'tts') row.voice = field(request, 'voice', 256, true);
  if (kind === 'asr' && provider === 'volcengine') {
    row.recognitionMode = field(request, 'recognitionMode', 30, true);
    if (!speechSelectionDefinitions.asrRecognitionMode.enum.includes(row.recognitionMode)) throw Error('MODEL_SERVICE_INVALID');
  }
  if (provider === 'volcengine' && !volcanoCatalog[kind].models.some(item=>item.id===model&&item.supported)) throw Error('SPEECH_MODEL_UNSUPPORTED');
  return row;
}

export function serviceSettings(row) {
  if (!row) return {};
  const { kind, provider, endpoint, model, voice, resourceId, recognitionMode } = row;
  switch (kind) {
    case 'llm': return { llmProvider: provider, llmEndpoint: endpoint, llmModel: model };
    case 'search': return { webSearchProvider: provider };
    case 'asr': return { asrMode: provider, asrEndpoint: endpoint, asrModel: model, asrResourceId: resourceId || '', ...(recognitionMode ? { asrRecognitionMode: recognitionMode } : {}) };
    case 'tts': return { ttsProvider: provider, ttsEndpoint: endpoint, ttsModel: model, ttsVoice: voice, ttsResourceId: resourceId || '' };
    default: return {};
  }
}

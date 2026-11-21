import { updateProviderProfiles } from './provider-profiles.mjs';
import { updateModelProfiles, validateModelEndpoint } from './model-providers.mjs';
import { speechParameterDefinitions, speechSelectionDefinitions } from './speech-catalog.mjs';
import {webSearchDefinitions} from './web-search-catalog.mjs';
import {asrDictionaryMaxLength,dictionaryTerms} from './asr-dictionary.mjs';

/** Shared settings data. Host-only model configuration stays out of DSH accounts. */
export const assistantSettingDefinitions = {
  ...speechParameterDefinitions,...speechSelectionDefinitions,
  persona: { default: '你是大肥鱼，也叫 DeepSeek 娘。自然、简洁地与用户交流，认真办事，不编造工具结果。', max: 16000 },
  onboardingComplete: { default: false }, assistantName: { default: '语音助手', max: 64 },
  voiceFavorites: { default: '[]', max: 16000 },
  agentPreset: { default: '' }, cwd: { default: '' }, manageAllWorkspaces: { default: true },
  electronExecutable: { default: '' }, asrMode: { default: 'compatible' }, asrProviderId: { default: '' },
  asrEndpoint: { default: 'https://api.openai.com/v1/audio/transcriptions' }, asrModel: { default: '' }, asrResourceId: { default: '' },
  asrDictionary: { default: '', max: asrDictionaryMaxLength },
  ttsProvider: { default: 'compatible' }, ttsEndpoint: { default: 'https://api.openai.com/v1/audio/speech' },
  ttsModel: { default: '' }, ttsVoice: { default: '' }, ttsResourceId: { default: '' },
  inputDeviceId: { default: '' }, outputDeviceId: { default: '' },
  silenceThreshold: { default: .01, min: .001, max: 1 }, silenceDurationMs: { default: 700, min: 200, max: 10000 },
  sampleMs: { default: 50, min: 10, max: 1000 }, voiceEnabled: { default: true }, outputEnabled: { default: true },
  keywordWakeEnabled: { default: false }, keywordWakeAliases: { default: '', max: 4096 },
  captionsEnabled: { default: false }, captionLocked: { default: false }, captionSkin: { default: 'dark' },
  captionFontSize: { default: 24, min: 16, max: 48 }, captionOpacity: { default: .85, min: .15, max: 1 },
  captionPosition: { default: 'bottom' }, captionX: { default: 0 }, captionY: { default: 0 },
  captionWidth: { default: 720, min: 320, max: 4096 }, captionHeight: { default: 150, min: 100, max: 2048 },
  captionHasBounds: { default: false }, petEnabled: { default: false }, petId: { default: '', max: 128 },
  petBubbles: { default: true }, petAnimation: { default: true },
};

export const standaloneModelDefinitions = {
  ...webSearchDefinitions,
  llmProvider: { default: 'compatible' },
  llmEndpoint: { default: 'https://api.openai.com/v1/chat/completions' },
  llmModel: { default: '' },
};

export function initialAssistantSettings({ host = 'standalone', overrides = {} } = {}) {
  const definitions = { ...assistantSettingDefinitions, ...(host === 'standalone' ? standaloneModelDefinitions : {}) };
  const defaults = Object.fromEntries(Object.entries(definitions).map(([name, spec]) => [name, spec.default]));
  if (host === 'dsh') defaults.asrMode = 'native';
  return validateAssistantSettings({ ...defaults, ...migrateAsrDictionary(overrides) }, host);
}

/** Read the former provider/model setting once and strip every persisted copy. */
function migrateAsrDictionary(settings) {
  const {asrHotwords, ...current} = settings;
  const profiles = settings.speechProfiles?.asr;
  const legacy = Object.values(profiles || {}).filter(profile => profile && Object.hasOwn(profile, 'asrHotwords'));
  if (!Object.hasOwn(settings, 'asrDictionary') && (asrHotwords !== undefined || legacy.length)) {
    // Prefer the active words and the latest provider settings over older model snapshots.
    const latest = [profiles?.[settings.asrMode]?.asrHotwords, profiles?.volcengine?.asrHotwords];
    const terms = dictionaryTerms([asrHotwords, ...latest, ...legacy.map(profile => profile.asrHotwords)]
      .filter(value => typeof value === 'string').join('\n'));
    let dictionary = '';
    for (const term of terms) {
      const separator = dictionary ? '\n' : '';
      if (dictionary.length + separator.length + term.length <= asrDictionaryMaxLength) dictionary += separator + term;
    }
    current.asrDictionary = dictionary;
  }
  if (legacy.length) {
    current.speechProfiles = structuredClone(settings.speechProfiles);
    for (const profile of Object.values(current.speechProfiles.asr)) {
      if (profile && typeof profile === 'object') delete profile.asrHotwords;
    }
  }
  return current;
}

export function validateAssistantSettings(value, host = 'standalone') {
  value = migrateAsrDictionary(value);
  const definitions = { ...assistantSettingDefinitions, ...(host === 'standalone' ? standaloneModelDefinitions : {}) };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'speechProfiles' || key === 'llmProfiles' && host === 'standalone') continue;
    const spec = definitions[key];
    if (!spec || typeof item !== typeof spec.default) throw Error('ASSISTANT_SETTINGS_INVALID');
    if (typeof item === 'string' && item.length > (spec.max ?? 2048)) throw Error('ASSISTANT_SETTINGS_INVALID');
    if (typeof item === 'number' && (!Number.isFinite(item) || item < (spec.min ?? -1e7) || item > (spec.max ?? 1e7))) throw Error('ASSISTANT_SETTINGS_INVALID');
    if (spec.integer && !Number.isInteger(item) || spec.enum && !spec.enum.includes(item)) throw Error('ASSISTANT_SETTINGS_INVALID');
  }
  if(value.voiceFavorites!==undefined){let favorites;try{favorites=JSON.parse(value.voiceFavorites)}catch{throw Error('ASSISTANT_SETTINGS_INVALID')}if(!Array.isArray(favorites)||favorites.length>100||favorites.some(item=>typeof item!=='string'||item.length>2048))throw Error('ASSISTANT_SETTINGS_INVALID')}
  if (!['light', 'dark'].includes(value.captionSkin) || !['top', 'bottom'].includes(value.captionPosition)) throw Error('ASSISTANT_SETTINGS_INVALID');
  if (host === 'standalone') {
    validateModelEndpoint(value.llmEndpoint,value.llmProvider||'compatible');
  }
  if (value.asrDictionary !== undefined) value.asrDictionary = dictionaryTerms(value.asrDictionary).join('\n');
  return structuredClone(value);
}

export function patchAssistantSettings(previous, patch, host = 'standalone') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('ASSISTANT_SETTINGS_INVALID');
  if (Object.hasOwn(patch, 'speechProfiles') || Object.hasOwn(patch,'llmProfiles')) throw Error('ASSISTANT_SETTINGS_INVALID');
  // Older clients may still write this key. Store only the shared setting.
  if (Object.hasOwn(patch, 'asrHotwords')) {
    const {asrHotwords, ...rest} = patch;
    patch = {asrDictionary:asrHotwords, ...rest};
  }
  previous = migrateAsrDictionary(previous);
  const speech=updateProviderProfiles(previous, patch, host);
  if (host !== 'standalone') return validateAssistantSettings(speech,host);
  const model = updateModelProfiles(previous,patch);
  return validateAssistantSettings({...speech,llmProvider:model.llmProvider,llmEndpoint:model.llmEndpoint,llmModel:model.llmModel,llmProfiles:model.llmProfiles},host);
}

/** Replay only public setting patches; previews and commits use the same reducer. */
export function previewAssistantSettings(previous, patches, host = 'standalone') {
  if (!Array.isArray(patches) || patches.length > 64 || patches.some(patch=>!patch||typeof patch!=='object'||Array.isArray(patch))) throw Error('ASSISTANT_SETTINGS_INVALID');
  return patches.reduce((config,patch)=>patchAssistantSettings(config,patch,host),structuredClone(previous));
}

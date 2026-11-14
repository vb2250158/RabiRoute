import { createHash } from 'node:crypto';
import { speechParameterDefinitions, speechSelectionDefinitions, applySpeechSelection } from './speech-catalog.mjs';

/** Public defaults contain no credentials. Each kind/provider owns its saved selection. */
export const speechProviders = Object.freeze({
  asr: [
    { id: 'native', label: 'DSH 已配置的识别服务', host: 'dsh', defaults: {} },
    { id: 'compatible', label: 'OpenAI / 兼容服务', defaults: { endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: '' } },
    { id: 'volcengine', label: '火山豆包', defaults: { endpoint: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', model: 'bigmodel', resourceId: 'volc.seedasr.sauc.duration' } },
  ],
  tts: [
    { id: 'compatible', label: 'OpenAI / 兼容服务', defaults: { endpoint: 'https://api.openai.com/v1/audio/speech', model: '', voice: '' } },
    { id: 'volcengine', label: '火山豆包', defaults: { endpoint: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection', model: 'seed-tts-2.0', resourceId: 'seed-tts-2.0', voice: '' } },
  ],
});

const selected = (config, kind) => kind === 'asr' ? config.asrMode : config.ttsProvider || 'compatible';
const fieldNames = ['endpoint', 'model', 'voice', 'resourceId'];
const fieldKey = (kind, name) => kind + name[0].toUpperCase() + name.slice(1);
const extraDefinitions={...speechParameterDefinitions,...speechSelectionDefinitions};

export function validateProviderEndpoint(value, provider) {
  let url;
  try { url = new URL(value); } catch { throw Error('SPEECH_ENDPOINT_INVALID'); }
  if (url.username || url.password || url.search || url.hash) throw Error('SPEECH_ENDPOINT_INVALID');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (provider === 'volcengine') {
    if (url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) throw Error('SPEECH_ENDPOINT_REQUIRES_WSS');
  } else if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw Error('SPEECH_ENDPOINT_REQUIRES_TLS');
  return url.href;
}

/** Never reuse credentials across kind, provider or normalized endpoint. */
export function speechCredentialRef(kind, provider, endpoint) {
  if (!speechProviders[kind]?.some(item => item.id === provider && provider !== 'native')) throw Error('SPEECH_PROVIDER_INVALID');
  const address = validateProviderEndpoint(endpoint, provider);
  return `${kind}:${provider}:${createHash('sha256').update(address).digest('hex')}`;
}

/** Preserve each provider's nonsecret fields while presenting legacy flat fields to hosts. */
export function updateProviderProfiles(previous, patch, host = 'standalone') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('ASSISTANT_SETTINGS_INVALID');
  const next = { ...previous, ...patch };
  const profiles = structuredClone(previous.speechProfiles || {});
  for (const kind of ['asr', 'tts']) {
    const oldId = selected(previous, kind), newId = selected(next, kind);
    const definition = speechProviders[kind].find(item => item.id === newId && (!item.host || item.host === host));
    if (!definition) throw Error('SPEECH_PROVIDER_INVALID');
    profiles[kind] ||= {};
    if (oldId) {
      const saved = { ...(profiles[kind][oldId] || {}) };
      for (const name of fieldNames) {
        if (kind === 'asr' && name === 'voice') continue;
        const key = fieldKey(kind, name);
        if (previous[key] !== undefined) saved[name] = previous[key];
      }
      profiles[kind][oldId] = saved;
    }
    const current = { ...definition.defaults, ...(profiles[kind][newId] || {}) };
    for (const name of fieldNames) {
      if (kind === 'asr' && name === 'voice') continue;
      const key = fieldKey(kind, name);
      if (Object.hasOwn(patch, key)) current[name] = patch[key];
      if (current[name] !== undefined && (typeof current[name] !== 'string' || current[name].length > 2048)) throw Error('ASSISTANT_SETTINGS_INVALID');
      next[key] = current[name] || '';
    }
    if (newId !== 'native') current.endpoint = next[fieldKey(kind, 'endpoint')] = validateProviderEndpoint(current.endpoint, newId);
    profiles[kind][newId] = current;
    const oldModelKey=oldId+'::'+previous[kind+'Model'],newModelKey=newId+'::'+next[kind+'Model'];
    const modelChanged=oldId===newId&&Object.hasOwn(patch,kind+'Model')&&patch[kind+'Model']!==previous[kind+'Model'];
    if(oldId==='volcengine'){
      profiles[kind][oldModelKey]={...profiles[kind][oldModelKey],...Object.fromEntries(Object.keys(extraDefinitions).filter(key=>key.startsWith(kind)&&previous[key]!==undefined).map(key=>[key,previous[key]])),...(kind==='tts'?{ttsVoice:previous.ttsVoice||''}:{})};
    }
    for(const [key,spec] of Object.entries(extraDefinitions).filter(([key])=>key.startsWith(kind))){
      profiles[kind][oldId] ||= {};
      if(previous[key]!==undefined)profiles[kind][oldId][key]=previous[key];
      const restored=modelChanged?(profiles[kind][newModelKey]?.[key]??spec.default):profiles[kind][newId][key];
      const value=Object.hasOwn(patch,key)?patch[key]:(restored??spec.default);
      if(typeof value!==typeof spec.default||spec.enum&&!spec.enum.includes(value)||spec.integer&&!Number.isInteger(value)||
        typeof value==='number'&&(!Number.isFinite(value)||value<(spec.min??-1e7)||value>(spec.max??1e7))||
        typeof value==='string'&&value.length>(spec.max??2048))throw Error('ASSISTANT_SETTINGS_INVALID');
      next[key]=value;
    }
    if(modelChanged&&kind==='tts'&&!Object.hasOwn(patch,'ttsVoice'))next.ttsVoice=profiles[kind][newModelKey]?.ttsVoice||'';
    applySpeechSelection(previous,next,patch,kind);
    // Persist effective protocol fields as well as parameter values.
    for(const name of fieldNames){if(kind==='asr'&&name==='voice')continue;profiles[kind][newId][name]=next[fieldKey(kind,name)]}
    for(const key of Object.keys(extraDefinitions).filter(key=>key.startsWith(kind)))profiles[kind][newId][key]=next[key];
    if(newId==='volcengine')profiles[kind][newModelKey]={...Object.fromEntries(Object.keys(extraDefinitions).filter(key=>key.startsWith(kind)).map(key=>[key,next[key]])),...(kind==='tts'?{ttsVoice:next.ttsVoice}:{})};
  }
  next.speechProfiles = profiles;
  return next;
}

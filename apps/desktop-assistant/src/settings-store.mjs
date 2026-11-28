import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transformWindowsSecret } from '@rabilink/desktop-voice-service/windows-secrets';
import { initialAssistantSettings, patchAssistantSettings, previewAssistantSettings } from '@rabilink/desktop-voice-service/settings';
import { speechCredentialRef } from '@rabilink/desktop-voice-service/provider-profiles';
import { modelCredentialRef } from '@rabilink/desktop-voice-service/model-providers';
import {webSearchCredentialRef} from '@rabilink/desktop-voice-service/web-search-catalog';
import { legacyModelServices, modelServiceCredentialKey, modelServiceDefinitions, validateModelService } from './model-services.mjs';

export async function openSettingsStore(directory, { protect = value => transformWindowsSecret(value, false), unprotect = value => transformWindowsSecret(value, true) } = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'settings.json');
  let settings = initialAssistantSettings(), encrypted = {}, services = {}, serial = Promise.resolve();
  try {
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (document.version !== 1 || !document.encrypted || typeof document.encrypted !== 'object') throw Error('ASSISTANT_SETTINGS_FILE_INVALID');
    settings = initialAssistantSettings({overrides:document.settings}); encrypted = document.encrypted;
    if (document.modelServices !== undefined) {
      if (!document.modelServices || typeof document.modelServices !== 'object' || Array.isArray(document.modelServices)) throw Error('MODEL_SERVICE_STORE_INVALID');
      services = Object.fromEntries(Object.entries(document.modelServices).map(([id, row]) => [id, validateModelService(row, id)]));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const enqueue = action => { const operation = serial.then(action); serial = operation.catch(() => {}); return operation; };
  const commit = async (nextSettings, nextEncrypted, nextServices = services, assertCurrent = () => {}) => {
    const pending = path + '.' + randomUUID() + '.tmp';
    await writeFile(pending, JSON.stringify({ version: 1, settings: nextSettings, encrypted: nextEncrypted,
      ...(Object.keys(nextServices).length ? {modelServices: nextServices} : {}) }, null, 2), { mode: 0o600 });
    assertCurrent();
    await rename(pending, path);
    settings = nextSettings; encrypted = nextEncrypted; services = nextServices;
  };
  const reference = (kind, endpoint, provider) => {
    if(kind==='search')return webSearchCredentialRef(provider);
    if (kind === 'llm') {
      return modelCredentialRef(provider || settings.llmProvider || 'compatible',endpoint);
    }
    return speechCredentialRef(kind, provider || (kind === 'asr' ? settings.asrMode : settings.ttsProvider), endpoint);
  };
  const legacyServices = () => legacyModelServices(settings,Boolean(encrypted[webSearchCredentialRef('tavily')]));
  const service = (id, kind) => {
    const found = Object.hasOwn(services, id) ? services[id] : legacyServices().find(row => row.id === id);
    return found && (!kind || found.kind === kind) ? structuredClone(found) : undefined;
  };
  const encryptedServiceKey = row => {
    if (Object.hasOwn(services, row.id)) return encrypted[modelServiceCredentialKey(row.id)];
    if (['workbuddy-cli', 'model-native', 'local-whisper'].includes(row.provider)) return undefined;
    return encrypted[reference(row.kind, row.endpoint, row.provider)];
  };
  const describeService = row => ({ ...row, configured: Boolean(encryptedServiceKey(row)),
    credentialMode: row.provider === 'workbuddy-cli' ? 'official-login' : ['model-native', 'local-whisper'].includes(row.provider) ? 'local' : 'key' });
  const listServices = () => [...legacyServices().filter(row => !Object.hasOwn(services, row.id)), ...Object.values(services)].map(describeService);
  return {
    read: () => structuredClone(settings),
    preview: patches => previewAssistantSettings(settings,patches),
    saveBatch: patches => enqueue(async () => { const next=previewAssistantSettings(settings,patches);if(patches.length)await commit(next,encrypted);return structuredClone(next); }),
    save: patch => enqueue(async () => { const next = patchAssistantSettings(settings, patch); await commit(next, encrypted); return structuredClone(next); }),
    modelServices: {
      list: listServices,
      definitions: modelServiceDefinitions,
      get: service,
      getSaved: (id, kind) => Object.hasOwn(services, id) ? service(id, kind) : undefined,
      resolve: async id => { const row = service(id); const value = row && encryptedServiceKey(row); return value ? unprotect(value) : undefined; },
      describe: id => { const row = service(id); return row && describeService(row); },
      save: (request, assertCurrent) => enqueue(async () => {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('MODEL_SERVICE_INVALID');
        if (request.id !== undefined && typeof request.id !== 'string') throw Error('MODEL_SERVICE_INVALID');
        const previous = request.id ? service(request.id) : undefined;
        if (request.id && !previous) throw Error('MODEL_SERVICE_NOT_FOUND');
        if (!previous && Object.keys(services).length >= 100) throw Error('MODEL_SERVICE_LIMIT');
        const row = validateModelService(request, previous?.id || randomUUID());
        if (previous && previous.kind !== row.kind) throw Error('MODEL_SERVICE_INVALID');
        const key = request.apiKey ?? '';
        if (typeof key !== 'string' || key.length > 8192 || /[\x00-\x1f\x7f]/.test(key)) throw Error('SPEECH_CREDENTIAL_INVALID');
        const next = { ...encrypted };
        const secretId = modelServiceCredentialKey(row.id);
        if (['workbuddy-cli', 'model-native', 'local-whisper'].includes(row.provider)) {
          if (key) throw Error('MODEL_SERVICE_KEY_UNSUPPORTED');
          delete next[secretId];
        } else if (key) next[secretId] = await protect(key);
        else if (previous?.provider === row.provider && previous.endpoint === row.endpoint) {
          const saved = encryptedServiceKey(previous);
          if (saved) next[secretId] = saved;
        } else delete next[secretId];
        await commit(settings, next, { ...services, [row.id]: row }, assertCurrent);
        return describeService(row);
      }),
    },
    credentials: {
      async describe(kind, endpoint, provider) {
        if(kind==='llm'&&provider==='workbuddy-cli')return {configured:true,writable:false,mode:'official-login'};
        return { configured: Boolean(encrypted[reference(kind, endpoint, provider)]), writable: true };
      },
      async resolve(kind, endpoint, provider) { const value = encrypted[reference(kind, endpoint, provider)]; return value ? unprotect(value) : undefined; },
      set: (kind, endpoint, key, provider) => {
        if(kind==='llm'&&provider==='workbuddy-cli')throw Error('WORKBUDDY_USES_OFFICIAL_LOGIN');
        const id = reference(kind, endpoint, provider);
        return enqueue(async () => {
        if (typeof key !== 'string' || key.length > 8192 || /[\r\n]/.test(key)) throw Error('SPEECH_CREDENTIAL_INVALID');
        const next = { ...encrypted };
        if (key) next[id] = await protect(key); else delete next[id];
        await commit(settings, next);
        return { configured: Boolean(next[id]), writable: true };
        });
      },
    },
  };
}

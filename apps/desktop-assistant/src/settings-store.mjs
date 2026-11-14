import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transformWindowsSecret } from '@rabilink/desktop-voice-service/windows-secrets';
import { initialAssistantSettings, patchAssistantSettings, validateAssistantSettings, previewAssistantSettings } from '@rabilink/desktop-voice-service/settings';
import { speechCredentialRef } from '@rabilink/desktop-voice-service/provider-profiles';
import { modelCredentialRef } from '@rabilink/desktop-voice-service/model-providers';

export async function openSettingsStore(directory, { protect = value => transformWindowsSecret(value, false), unprotect = value => transformWindowsSecret(value, true) } = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'settings.json');
  let settings = initialAssistantSettings(), encrypted = {}, serial = Promise.resolve();
  try {
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (document.version !== 1 || !document.encrypted || typeof document.encrypted !== 'object') throw Error('ASSISTANT_SETTINGS_FILE_INVALID');
    settings = validateAssistantSettings({ ...settings, ...document.settings }); encrypted = document.encrypted;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const enqueue = action => { const operation = serial.then(action); serial = operation.catch(() => {}); return operation; };
  const commit = async (nextSettings, nextEncrypted) => {
    const pending = path + '.' + randomUUID() + '.tmp';
    await writeFile(pending, JSON.stringify({ version: 1, settings: nextSettings, encrypted: nextEncrypted }, null, 2), { mode: 0o600 });
    await rename(pending, path);
    settings = nextSettings; encrypted = nextEncrypted;
  };
  const reference = (kind, endpoint, provider) => {
    if (kind === 'llm') {
      return modelCredentialRef(provider || settings.llmProvider || 'compatible',endpoint);
    }
    return speechCredentialRef(kind, provider || (kind === 'asr' ? settings.asrMode : settings.ttsProvider), endpoint);
  };
  return {
    read: () => structuredClone(settings),
    preview: patches => previewAssistantSettings(settings,patches),
    saveBatch: patches => enqueue(async () => { const next=previewAssistantSettings(settings,patches);if(patches.length)await commit(next,encrypted);return structuredClone(next); }),
    save: patch => enqueue(async () => { const next = patchAssistantSettings(settings, patch); await commit(next, encrypted); return structuredClone(next); }),
    credentials: {
      async describe(kind, endpoint, provider) { return { configured: Boolean(encrypted[reference(kind, endpoint, provider)]), writable: true }; },
      async resolve(kind, endpoint, provider) { const value = encrypted[reference(kind, endpoint, provider)]; return value ? unprotect(value) : undefined; },
      set: (kind, endpoint, key, provider) => {
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

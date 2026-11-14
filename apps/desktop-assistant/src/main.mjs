import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { openSettingsStore } from './settings-store.mjs';
import { createStandaloneConversation } from './conversation.mjs';
import { openAssistantServer } from './server.mjs';
import { createResidentHost } from '@rabilink/desktop-voice-service/host';
import { openDesktopDevice } from '@rabilink/desktop-voice-service/node';
import { createSpeechProviders } from '@rabilink/desktop-voice-service/speech-providers';
import { speechProviders } from '@rabilink/desktop-voice-service/provider-profiles';
import { modelProviders } from '@rabilink/desktop-voice-service/model-providers';

/** Thin binding only: shared host owns lifecycle and the shared SDK owns conversation. */
export async function startStandalone({ directory, publicDirectory, port = 0, deviceFactory = openDesktopDevice, providerFactory = createSpeechProviders, onExit = () => {} }) {
  const store = await openSettingsStore(directory);
  let conversation, server, disposed = false;
  const host = createResidentHost({ settings: store.read, saveSettings: store.save, previewSettings: store.preview, saveSettingsBatch: store.saveBatch, credentials: store.credentials, deviceFactory,
    conversation: ({ onError }) => conversation = createStandaloneConversation({ settings: store.read, credentials: store.credentials, onError }),
    observeOutput: ({ conversation, ...observer }) => conversation.observe(observer),
    createProviders: config => providerFactory({ config, credentials: store.credentials }),
    openSettings: () => server && host.openSettings(server.url),
  });
  const bound = {
    async state() {
      const state = await host.state();
      return { ...state, capabilities: { host: 'standalone', tools: false, modelProviders, speechProviders: Object.fromEntries(Object.entries(speechProviders).map(([kind, values]) => [kind, values.filter(item => !item.host).map(({ id, label }) => ({ id, label }))])) },
        credentials: { ...state.credentials, llm: await store.credentials.describe('llm', store.read().llmEndpoint,store.read().llmProvider) } };
    },
    command: host.command,
    async dispose() { if (disposed) return; await host.dispose(); await conversation.drain(); disposed = true; },
  };
  try { server = await openAssistantServer({ host: bound, messages: conversation.messages, directory: publicDirectory, port, onExit }); }
  catch (error) { await bound.dispose(); throw error; }
  return { ...server, state: bound.state, async dispose() { await bound.dispose(); await server.close(); } };
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replaceAll('\\', '/')).href) {
  const directory = process.env.ASSISTANT_DATA_DIR || join(process.env.LOCALAPPDATA, 'RabiAssistant');
  await mkdir(directory, { recursive: true });
  let app;
  const readyPath = join(directory, 'ready.json');
  const exit = async () => { await rm(readyPath, { force: true }); process.exitCode = 0; };
  try {
    app = await startStandalone({ directory, publicDirectory: join(import.meta.dirname, '../public'), port: Number(process.env.ASSISTANT_PORT || 0), onExit: exit });
    await writeFile(readyPath, JSON.stringify({ pid: process.pid, url: app.url, startedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('ASSISTANT_READY ' + app.origin);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await app.dispose(); await exit(); } catch { console.error('ASSISTANT_CLEANUP_UNCONFIRMED'); process.exitCode = 1; } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'ASSISTANT_START_FAILED'); process.exitCode = 1; }
}

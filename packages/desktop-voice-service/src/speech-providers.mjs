import { randomUUID } from 'node:crypto';
import { createHttpSpeechProviders } from './providers.mjs';
import { createVolcanoAsr } from './volcano-asr.mjs';
import { openVolcanoTts } from './volcano-tts.mjs';
import { validateProviderEndpoint } from './provider-profiles.mjs';
import { encodeVolcanoTtsParams } from './speech-catalog.mjs';

/** Provider selection is shared; credentials are always resolved for one fixed target. */
export function createSpeechProviders({ config, credentials, connect, fetcher }) {
  const http = createHttpSpeechProviders({
    ...(config.asrMode === 'compatible' ? { asr: { endpoint: config.asrEndpoint, model: config.asrModel, credentialRef: 'asr' } } : {}),
    ...(config.ttsProvider !== 'volcengine' ? { tts: { endpoint: config.ttsEndpoint, model: config.ttsModel, voice: config.ttsVoice, credentialRef: 'tts' } } : {}),
    resolveCredential: kind => credentials.resolve(kind, config[kind + 'Endpoint'], 'compatible'), ...(fetcher ? { fetcher } : {}),
  });
  const connection = async kind => {
    const endpoint = validateProviderEndpoint(config[kind + 'Endpoint'], 'volcengine');
    const key = await credentials.resolve(kind, endpoint, 'volcengine');
    if (!key) throw Error('SPEECH_CREDENTIAL_REQUIRED');
    const resource = config[kind + 'ResourceId'];
    if (!resource || /[\r\n]/.test(resource)) throw Error('SPEECH_RESOURCE_REQUIRED');
    return { endpoint, headers: { 'X-Api-Key': key, 'X-Api-Resource-Id': resource, [kind === 'asr' ? 'X-Api-Request-Id' : 'X-Api-Connect-Id']: randomUUID() } };
  };
  return { ...http,
    ...(config.asrMode === 'volcengine' ? { createAsr: ({ createRecording }) => createVolcanoAsr({ createRecording, settings: () => config, connection: () => connection('asr'), connect }) } : {}),
    ...(config.ttsProvider === 'volcengine' ? { openSpeechStream: async ({ signal, onAudio }) => openVolcanoTts({ ...await connection('tts'), voice: config.ttsVoice, requestParams:encodeVolcanoTtsParams(config), signal, onAudio, connect }) } : {}),
  };
}

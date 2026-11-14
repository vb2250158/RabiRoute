import test from 'node:test';
import assert from 'node:assert/strict';
import { updateProviderProfiles, speechCredentialRef } from '../src/provider-profiles.mjs';

test('provider switching restores each configuration without sharing credential identity', () => {
  let settings = updateProviderProfiles({ asrMode: 'compatible', ttsProvider: 'compatible' }, {});
  settings = updateProviderProfiles(settings, { asrModel: 'my-asr', ttsModel: 'my-tts', ttsVoice: 'alloy' });
  const original = speechCredentialRef('asr', 'compatible', settings.asrEndpoint);
  settings = updateProviderProfiles(settings, { asrMode: 'volcengine', ttsProvider: 'volcengine' });
  assert.equal(settings.asrResourceId, 'volc.seedasr.sauc.duration');
  assert.equal(settings.ttsResourceId, 'seed-tts-2.0');
  assert.notEqual(speechCredentialRef('asr', 'volcengine', settings.asrEndpoint), original);
  settings = updateProviderProfiles(settings, { ttsVoice: 'speaker-from-console' });
  settings = updateProviderProfiles(settings, { asrMode: 'compatible', ttsProvider: 'compatible' });
  assert.equal(settings.asrModel, 'my-asr');
  assert.equal(settings.ttsVoice, 'alloy');
  assert.equal(speechCredentialRef('asr', 'compatible', settings.asrEndpoint), original);
  settings = updateProviderProfiles(settings, { ttsProvider: 'volcengine' });
  assert.equal(settings.ttsVoice, 'speaker-from-console');
});

test('credentials never follow kind or endpoint changes and unsafe endpoints are rejected', () => {
  const url = 'https://example.com/audio';
  assert.notEqual(speechCredentialRef('asr', 'compatible', url), speechCredentialRef('tts', 'compatible', url));
  assert.notEqual(speechCredentialRef('asr', 'compatible', url), speechCredentialRef('asr', 'compatible', url + '/other'));
  assert.throws(() => speechCredentialRef('asr', 'compatible', 'https://u:p@example.com/audio'), /ENDPOINT_INVALID/);
  assert.throws(() => speechCredentialRef('asr', 'volcengine', 'ws://example.com/audio'), /REQUIRES_WSS/);
  assert.throws(() => updateProviderProfiles({ asrMode: 'compatible', ttsProvider: 'compatible' }, { asrMode: 'native' }), /PROVIDER_INVALID/);
});

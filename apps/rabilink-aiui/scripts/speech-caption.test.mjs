import test from 'node:test';
import assert from 'node:assert/strict';
import { speechCaption } from '../utils/speech-caption.js';

test('native UTF-16 offsets select the actual repeated word', () => {
  assert.deepEqual(speechCaption('你好，你好。', { text: '你好', charIndex: 3, charLength: 2 }),
    { playbackCaptionText: '你好，你好。', playbackCaptionStart: 3, playbackCaptionLength: 2 });
});
test('older native cues highlight only their returned text, without estimated offsets', () => {
  assert.deepEqual(speechCaption('同一句里的词和词。', { text: '词' }),
    { playbackCaptionText: '词', playbackCaptionStart: 0, playbackCaptionLength: 1 });
  assert.equal(speechCaption('正常回答', null).playbackCaptionLength, 0);
});
test('long captions follow actual cues into the visible region without splitting supplementary characters', () => {
  const text = '开头'.repeat(35) + '🌧️正在播放。';
  const patch = speechCaption(text, { text: '正在', charIndex: text.indexOf('正在'), charLength: 2 });
  assert.ok(Array.from(patch.playbackCaptionText).length <= 24);
  assert.equal(patch.playbackCaptionText.slice(patch.playbackCaptionStart, patch.playbackCaptionStart + patch.playbackCaptionLength), '正在');
});

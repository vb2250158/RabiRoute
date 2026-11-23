import assert from 'node:assert/strict';
import test from 'node:test';
import { chatComposerAction, readChatComposerShortcuts, saveChatComposerShortcuts } from '../src/chatComposerShortcuts';

const enter = { key: 'Enter', isComposing: false, keyCode: 13, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };

test('Agent chat defaults to Enter send and Alt+Enter newline and ignores composing Enter', () => {
  const defaults = readChatComposerShortcuts();
  assert.equal(chatComposerAction(enter, defaults), 'send');
  assert.equal(chatComposerAction({ ...enter, altKey: true }, defaults), 'newline');
  assert.equal(chatComposerAction({ ...enter, altKey: true, ctrlKey: true }, defaults), undefined);
  assert.equal(chatComposerAction({ ...enter, isComposing: true }, defaults), undefined);
  assert.equal(chatComposerAction({ ...enter, keyCode: 229 }, defaults), undefined);
});

test('settings persist distinct shortcuts and the composer reads them after changes', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { setItem: (key: string, value: string) => values.set(key, value), getItem: (key: string) => values.get(key) }
  } });
  try {
    saveChatComposerShortcuts({ send: 'Ctrl+Enter', newline: 'Enter' });
    const saved = readChatComposerShortcuts();
    assert.equal(chatComposerAction(enter, saved), 'newline');
    assert.equal(chatComposerAction({ ...enter, ctrlKey: true }, saved), 'send');
    assert.equal(chatComposerAction({ ...enter, altKey: true }, saved), undefined);
    assert.throws(() => saveChatComposerShortcuts({ send: 'Enter', newline: 'Enter' }));
    assert.deepEqual(readChatComposerShortcuts(), saved);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

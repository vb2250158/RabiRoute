export const chatComposerKeys = ['Enter', 'Alt+Enter', 'Shift+Enter', 'Ctrl+Enter', 'Meta+Enter'] as const;
type ChatComposerKey = typeof chatComposerKeys[number];
export type ChatComposerShortcuts = { send: ChatComposerKey; newline: ChatComposerKey };

const storageKey = 'rabiroute:webgui:agent-chat-shortcuts';
const defaults: ChatComposerShortcuts = { send: 'Enter', newline: 'Alt+Enter' };

export function validChatComposerShortcuts(value: unknown): value is ChatComposerShortcuts {
  if (!value || typeof value !== 'object') return false;
  const { send, newline } = value as Partial<ChatComposerShortcuts>;
  return send !== undefined && newline !== undefined && send !== newline
    && chatComposerKeys.includes(send) && chatComposerKeys.includes(newline);
}

export function readChatComposerShortcuts(): ChatComposerShortcuts {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    if (validChatComposerShortcuts(saved)) return saved;
  } catch { /* The default shortcuts remain available when storage is inaccessible. */ }
  return { ...defaults };
}

export function saveChatComposerShortcuts(value: ChatComposerShortcuts): void {
  if (!validChatComposerShortcuts(value)) throw new Error('Invalid chat composer shortcuts.');
  window.localStorage.setItem(storageKey, JSON.stringify(value));
}

type EnterEvent = Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;
export function chatComposerAction(event: EnterEvent, shortcuts: ChatComposerShortcuts): keyof ChatComposerShortcuts | undefined {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  const chord = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '', 'Enter'].filter(Boolean).join('+');
  if (chord === shortcuts.send) return 'send';
  if (chord === shortcuts.newline) return 'newline';
}

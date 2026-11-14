import { randomUUID } from 'node:crypto';
import { createAssistantSession } from '@rabilink/assistant-runtime/session';
import { createAssistantConversation } from '@rabilink/assistant-runtime/conversation';
import { createChatModel } from '@rabilink/desktop-voice-service/chat-model';

/** Standalone binding for the shared session/queue. No DSH tools or accounts are impersonated. */
export function createStandaloneConversation({ settings, credentials, onError, createModel = createChatModel }) {
  const id = 'local-' + randomUUID().slice(0, 30), listeners = new Set(), accepted = new Map(), pending = new Set();
  let messages = [], closed = false, observer;
  const publish = () => { for (const listener of listeners) listener(messages.slice(-100)); };
  const profile = () => { const value = settings(); return { systemPrompt: value.persona, modelOptions: { endpoint: value.llmEndpoint, model: value.llmModel,provider:value.llmProvider||'compatible' } }; };
  let configuredProfile = profile();
  const session = createAssistantSession({
    sessionId: id, profile: configuredProfile,
    createModel: (options, { signal }) => createModel({ ...options, signal, resolveCredential: endpoint => credentials.resolve('llm', endpoint,options.provider) }),
    discoverTools: async () => ({ tools: [], executeTool() { throw Error('ASSISTANT_TOOLS_UNAVAILABLE'); },
      toolPolicy: { classify: () => ({ mutation: false }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: true }) } }),
  });
  const conversation = createAssistantConversation({ session, scope: id, capacity: 8,
    receipts: { has: async () => false, acknowledge: async () => true } });
  return {
    eventSource: undefined,
    async open() { if (closed) throw Error('ASSISTANT_CLOSED'); return id; },
    getSessionId: () => id,
    observe(value) { observer = value; return () => { if (observer === value) observer = undefined; }; },
    subscribe(listener) { listeners.add(listener); listener(messages.slice(-100)); return () => listeners.delete(listener); },
    messages: () => messages.slice(-100),
    configure() {
      const next = profile();
      if (JSON.stringify(next) === JSON.stringify(configuredProfile)) return { applied: false, deferred: false };
      const result = session.configure(next); configuredProfile = next; return result;
    },
    async submit(text, requestId) {
      if (closed) throw Error('ASSISTANT_CLOSED');
      if (typeof text !== 'string' || !text.trim() || text.length > 16000 || typeof requestId !== 'string' || requestId.length > 128) throw Error('ASSISTANT_INPUT_INVALID');
      if (!settings().llmModel.trim()) throw Error('ASSISTANT_MODEL_REQUIRED');
      const previous = accepted.get(requestId);
      if (previous) {
        if (previous !== text) throw Error('ASSISTANT_REQUEST_CONFLICT');
        return { accepted: true, sessionId: id, requestId };
      }
      if (pending.size >= 8) throw Error('ASSISTANT_INPUT_QUEUE_FULL');
      accepted.set(requestId, text);
      while (accepted.size > 256) accepted.delete(accepted.keys().next().value);
      messages.push({ id: requestId, role: 'user', text });
      messages = messages.slice(-100); publish();
      let token, started = false, response;
      const begin = () => {
        if (started) return;
        started = true;
        response = { id: 'reply-' + requestId, role: 'assistant', text: '' };
        messages.push(response); messages = messages.slice(-100);
        if (observer?.voice.getState().phase === 'running') token = observer.voice.beginResponse({ id: response.id });
      };
      const work = conversation.run(text, {
        assertCurrent() { if (closed) throw Error('ASSISTANT_CLOSED'); },
        onState() { begin(); },
        onText(value) {
          if (closed) return;
          begin(); response.text = value.text; token?.append(value.delta);
          observer?.onText({ responseId: response.id, text: value.text }); publish();
        },
      }).then(result => {
        token?.finish({ speak: result.state === 'completed' });
      }, error => {
        token?.finish({ speak: false });
        if (closed) return;
        const cause = error.cause || error;
        const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(cause.message) ? cause.message : 'ASSISTANT_MODEL_FAILED';
        messages.push({ id: 'error-' + requestId, role: 'assistant', text: code, notice: true });
        messages = messages.slice(-100); publish(); onError(Error(code));
      }).finally(() => pending.delete(work));
      pending.add(work);
      return { accepted: true, sessionId: id, requestId };
    },
    close() { if (closed) return; closed = true; conversation.dispose(); session.dispose(); observer = undefined; listeners.clear(); },
    async drain() { await Promise.allSettled([...pending]); },
  };
}

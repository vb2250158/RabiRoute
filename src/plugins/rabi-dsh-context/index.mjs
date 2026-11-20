import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { hasConfiguredHookRoute, requestHook } from './manager-client.mjs';

// Cordis accepts Standard Schema directly, including for a Hook linked from the RabiRoute install.
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'rabi-dsh-context',
    validate(input) {
      const value = input?.hostExecutable;
      const hostExecutable = typeof value === 'string' ? value.trim() : '';
      if ((value !== undefined && typeof value !== 'string') || (hostExecutable && !path.isAbsolute(hostExecutable))) {
        return { issues: [{ path: ['hostExecutable'], message: 'hostExecutable must be an absolute path or empty.' }] };
      }
      return { value: { hostExecutable } };
    }
  }
};

function textContent(message) {
  // DSH messages may contain non-text blocks; only forward readable text.
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function contextMessage(text) {
  // Mark injected context as plugin-originated so it is not submitted again.
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'rabi-dsh-context', form: 'notice', summary: 'Rabi 角色上下文' } };
}

/** Thin lifecycle adapter: all decisions and context remain owned by Manager. */
export function apply(ctx, config = {}, request = requestHook) {
  const nativeOwnsEvents = () => ctx.get?.('rabiAgentHooks')?.supportsCompanionTransport === true;
  const hostExecutable = config.hostExecutable?.trim();
  const hasConfiguredRoute = () => hasConfiguredHookRoute(hostExecutable);
  const sendHook = hostExecutable
    ? (input, options) => request(input, { ...options, hostExecutable })
    : request;
  ctx.effect?.(() => ctx.provide('rabiDshHookTransport', { hasConfiguredRoute, request: sendHook }));
  const starts = new Map();
  const finals = new Map();
  const turns = new Map();
  const progress = new WeakMap();
  const shutdown = new AbortController();
  ctx.effect?.(() => () => shutdown.abort());
  const status = { version: '0.1.3', lastError: '' };
  const invoke = async (agent, eventName, fields = {}) => {
    // Every lifecycle decision is delegated to Manager; this adapter only
    // translates DSH event fields and keeps the host usable on failures.
    try {
      const result = await sendHook({ agentType: 'dsh', sessionId: agent.id, eventName, turnId: turns.get(agent.id), ...fields });
      status.lastError = '';
      return result;
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[rabi-dsh-context]', status.lastError);
      return {};
    }
  };
  // Cache the start reason until DSH opens the first turn for this session.
  ctx.on('agent/created', ({ agent, source }) => { starts.set(agent.id, source); }, { global: true });
  ctx.on('session/event', (session, event) => {
    // Remember the latest non-interrupted assistant message for Stop.
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      finals.set(session.id, { turn: event.data.turn, text: textContent(event.data.message) });
    }
    if (event.type === 'turn/start') {
      progress.set(session, { turn: event.data.turn, message: null });
      return;
    }
    const active = progress.get(session);
    if (!active || active.turn !== event.data?.turn) return;
    if (event.type === 'turn/end') {
      progress.delete(session);
      return;
    }
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !event.data.interrupted) {
      const { step, message } = event.data;
      const text = message?.role === 'assistant' ? textContent(message) : '';
      if (Number.isSafeInteger(step) && typeof message?.id === 'string' && message.id.trim() && text.trim()) {
        active.message = { step, id: message.id, text };
      }
      return;
    }
    const message = active.message;
    if (event.type !== 'step/start' || !message || event.data.step <= message.step) return;
    active.message = null;
    // A subsequent native step proves the previous public text was not the final answer.
    // When the native Hook owns routing, use its companion route only if it actually selected one.
    if (shutdown.signal.aborted || nativeOwnsEvents() && !hasConfiguredRoute()) return;
    const input = { agentType: 'dsh', sessionId: session.id, eventName: 'AssistantProgress', turnId: String(active.turn),
      messageId: message.id, observedAt: Date.now(), cwd: ctx.workingDirectory?.get(session) ?? session.header?.cwd,
      lastAssistantMessage: message.text };
    void sendHook(input, { signal: shutdown.signal }).then(result => {
      if (result?.completionDeliveries?.some(item => item.status === 'failed')) {
        console.warn('[rabi-dsh-context] Progress delivery failed; review the Manager receipt.');
      }
    }).catch(() => {
      if (!shutdown.signal.aborted) console.warn('[rabi-dsh-context] Progress delivery was not confirmed.');
    });
  }, { global: true });
  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    // Inject SessionStart and user-prompt context immediately before a turn.
    turns.set(agent.id, String(turn));
    const decision = await next();
    if (nativeOwnsEvents()) {
      starts.delete(agent.id);
      return decision;
    }
    if (decision.kind !== 'enter') return decision;
    const contexts = [];
    if (starts.has(agent.id)) {
      const source = starts.get(agent.id);
      starts.delete(agent.id);
      const data = await invoke(agent, 'SessionStart', { source });
      if (data.additionalContext) contexts.push(data.additionalContext);
    }
    const prompt = messages.filter(message => message.source?.kind !== 'rabi-dsh-context').map(textContent).filter(Boolean).join('\n');
    if (prompt) {
      const data = await invoke(agent, 'UserPromptSubmit', { prompt, turnId: String(turn) });
      if (data.additionalContext) contexts.push(data.additionalContext);
    }
    return { ...decision, messages: contexts.length ? [...decision.messages, contextMessage(contexts.join('\n'))] : decision.messages };
  }, { global: true });
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Ask Manager for permission before a tool runs; a denial prevents next().
    if (!exec.agent || nativeOwnsEvents()) return next();
    const data = await invoke(exec.agent, 'PreToolUse', { toolName: exec.name, toolInput: exec.arguments, toolUseId: exec.callId });
    if (data.toolDecision?.permissionDecision === 'deny') return { kind: 'deny', reason: data.toolDecision.reason };
    if (data.additionalContext) exec.agent.inject(contextMessage(data.additionalContext));
    return next();
  }, { global: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Give Manager the tool result and allow it to add follow-up context.
    if (exec.agent && !nativeOwnsEvents()) {
      const data = await invoke(exec.agent, 'PostToolUse', { toolName: exec.name, toolUseId: exec.callId, toolInput: exec.arguments, toolResponse: result });
      if (data.additionalContext) exec.agent.inject(contextMessage(data.additionalContext));
    }
    return next();
  }, { global: true });
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    // Close the lifecycle with the final assistant text, then release it.
    const final = finals.get(agent.id);
    if (!nativeOwnsEvents()) await invoke(agent, 'Stop', { turnId: String(turn), lastAssistantMessage: final?.turn === turn ? final.text : '' });
    finals.delete(agent.id);
  }, { global: true });
  // Remove all per-session state when DSH disposes the agent.
  ctx.on('agent/disposed', ({ agent }) => { starts.delete(agent.id); finals.delete(agent.id); turns.delete(agent.id); }, { global: true });
}

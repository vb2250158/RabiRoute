import { randomUUID } from 'node:crypto';
import { requestHook } from './manager-client.mjs';

function textContent(message) {
  // DSH messages may contain non-text blocks; only forward readable text.
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function contextMessage(text) {
  // Mark injected context as plugin-originated so it is not submitted again.
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'rabi-dsh-context', form: 'notice', summary: 'Rabi 人格上下文' } };
}

/** Thin lifecycle adapter: all decisions and context remain owned by Manager. */
export function apply(ctx, config = {}, request = requestHook) {
  const starts = new Map();
  const finals = new Map();
  const turns = new Map();
  const status = { version: '0.1.0', lastError: '' };
  const invoke = async (agent, eventName, fields = {}) => {
    // Every lifecycle decision is delegated to Manager; this adapter only
    // translates DSH event fields and keeps the host usable on failures.
    try {
      const result = await request({ agentType: 'dsh', sessionId: agent.id, eventName, turnId: turns.get(agent.id), ...fields });
      status.lastError = '';
      return result;
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[rabi-dsh-context]', status.lastError);
      return {};
    }
  };
  // Cache the start reason until DSH opens the first turn for this session.
  ctx.on('agent/session-start', ({ agent, source }) => { starts.set(agent.id, source); }, { global: true });
  ctx.on('session/event', (session, event) => {
    // Remember the latest non-interrupted assistant message for Stop.
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      finals.set(session.id, { turn: event.data.turn, text: textContent(event.data.message) });
    }
  }, { global: true });
  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    // Inject SessionStart and user-prompt context immediately before a turn.
    turns.set(agent.id, String(turn));
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const contexts = [];
    if (starts.has(agent.id)) {
      const data = await invoke(agent, 'SessionStart', { source: starts.get(agent.id) });
      starts.delete(agent.id);
      if (data.additionalContext) contexts.push(data.additionalContext);
    }
    const prompt = messages.filter(message => message.source?.plugin !== 'rabi-dsh-context').map(textContent).filter(Boolean).join('\n');
    if (prompt) {
      const data = await invoke(agent, 'UserPromptSubmit', { prompt, turnId: String(turn) });
      if (data.additionalContext) contexts.push(data.additionalContext);
    }
    return { ...decision, messages: contexts.length ? [...decision.messages, contextMessage(contexts.join('\n'))] : decision.messages };
  }, { global: true });
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Ask Manager for permission before a tool runs; a denial prevents next().
    if (!exec.agent) return next();
    const data = await invoke(exec.agent, 'PreToolUse', { toolName: exec.name, toolInput: exec.arguments, toolUseId: exec.callId });
    if (data.toolDecision?.permissionDecision === 'deny') return { kind: 'deny', reason: data.toolDecision.reason };
    if (data.additionalContext) exec.agent.inject(contextMessage(data.additionalContext));
    return next();
  }, { global: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Give Manager the tool result and allow it to add follow-up context.
    if (exec.agent) {
      const data = await invoke(exec.agent, 'PostToolUse', { toolName: exec.name, toolUseId: exec.callId, toolInput: exec.arguments, toolResponse: result });
      if (data.additionalContext) exec.agent.inject(contextMessage(data.additionalContext));
    }
    return next();
  }, { global: true });
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    // Close the lifecycle with the final assistant text, then release it.
    const final = finals.get(agent.id);
    await invoke(agent, 'Stop', { turnId: String(turn), lastAssistantMessage: final?.turn === turn ? final.text : '' });
    finals.delete(agent.id);
  }, { global: true });
  // Remove all per-session state when DSH disposes the agent.
  ctx.on('agent/disposed', ({ agent }) =>{ starts.delete(agent.id); finals.delete(agent.id); turns.delete(agent.id); }, { global: true });
  return status;
}

import { createTaskUtteranceBuffer, type TaskInputPacket } from '@rabilink/rokid-voice/task-input';
import { createTaskInputHandoffBuffer } from '@rabilink/rokid-voice/task-input-handoff';
const queue: TaskInputPacket[] = [];
const buffer = createTaskUtteranceBuffer({ scope: 'backend/host/generation/task', onReady: packet => { queue.push(packet); return true; } });
buffer.speechStart(); buffer.final({ resultId: 'asr-1', text: '查接口' }); buffer.speechEnd();
buffer.configure({ silenceMs: 2000 });
const draft = buffer.dispose();
if (draft) {
  const next = createTaskUtteranceBuffer({ scope: draft.scope, onReady: () => true });
  next.restoreDraft(draft); next.resumeDraft();
  // @ts-expect-error The receiver cannot mutate buffered segments.
  draft.segments.push({ resultId: 'injected', text: 'invalid' });
}
// @ts-expect-error Receivers hand off synchronously, not through an async backend request.
createTaskUtteranceBuffer({ scope: 'scope', onReady: async () => true });
const persistent = createTaskInputHandoffBuffer({ scope: 'scope', createHandoffId: () => 'stable-id',
  retain: async input => ({ status: 'retained', handoffId: input.handoffId }) });
void persistent.flush().then(result => { if ('status' in result) result.packet satisfies TaskInputPacket; });
for (const handoff of persistent.dispose().handoffs) void handoff.completion;

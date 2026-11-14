import { createAgentTurnRuntime as createSharedTurn } from '../../../packages/assistant-runtime/src/turn-runtime.js';
import { rabiAgentProtocol } from './agent-decision-protocol.js';
import { rabiAgentToolPolicy } from './rabi-agent-tool-policy.js';

// Rabi owns protocol compatibility and backend receipt semantics.
export function createAgentTurnRuntime(options) {
  return createSharedTurn({ ...options, protocol: rabiAgentProtocol, toolPolicy: rabiAgentToolPolicy });
}

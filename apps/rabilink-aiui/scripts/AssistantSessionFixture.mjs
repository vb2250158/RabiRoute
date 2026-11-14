import { createAssistantSession } from '../../../packages/assistant-runtime/src/assistant-session.js';
import { attachPageVoiceFixture } from './VoicePageFixture.mjs';
import { rabiAgentProtocol } from '../utils/agent-decision-protocol.js';
import { rabiAgentToolPolicy } from '../utils/rabi-agent-tool-policy.js';

// Inject only the model/backend; exercise the production shared session owner.
export function createPageAssistantFixture(page, model) {
  attachPageVoiceFixture(page);
  return createAssistantSession({
    protocol: rabiAgentProtocol, profile: { systemPrompt: '测试宿主提示词' }, createModel: () => model,
    discoverTools: async () => ({
      tools: (page.chatModelAgentTools || []).map(tool => typeof tool === 'string' ? { function: { name: tool } } : tool),
      toolPolicy: rabiAgentToolPolicy,
      executeTool: event => page.executeChatTool(event, page.chatModelApiRuntime)
    })
  });
}

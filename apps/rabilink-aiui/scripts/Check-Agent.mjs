import { spawnSync } from 'node:child_process';
import path from 'node:path';
const cwd = path.resolve(import.meta.dirname, '..');
const smoke = ['Smoke-AgentProfile.mjs','Smoke-AgentProfilePage.mjs','Smoke-RabiLinkChatGeneration.mjs','Smoke-AgentTurnRuntime.mjs','Test-AiuiExitContract.mjs','Smoke-AiuiGuidance.mjs','Test-AiuiInputLedger.mjs','Smoke-AiuiPersonaIntegration.mjs','Smoke-ApiResultPage.mjs','Smoke-GenericManagerTransport.mjs','Smoke-KnowledgeResultView.mjs','Smoke-RabiLinkVoiceRuntime.mjs','Smoke-RabiLinkAiuiStartupSafety.mjs'];
const runs = [['scripts/Audit-AiuiDevSkill.mjs'], ['--test','../../packages/assistant-runtime/test/turn-runtime.test.mjs','../../packages/assistant-runtime/test/tool-interjection.test.mjs','../../packages/assistant-runtime/test/interjection-receipts.test.mjs','../../packages/assistant-runtime/test/assistant-session.test.mjs','../../packages/assistant-runtime/test/aiui-runtime.test.mjs','../../packages/assistant-runtime/test/conversation-runtime.test.mjs','../../packages/rokid-voice/test/task-input.test.mjs','../../packages/rokid-voice/test/task-input-handoff.test.mjs'], ...smoke.map(name => [path.join('scripts',name)]), ['--test','scripts/Smoke-PhoneEyeTransport.mjs','scripts/Smoke-DeviceAgentPage.mjs','scripts/webgui-coverage.test.mjs','scripts/config-surface-contract.test.mjs','scripts/rokid-status-contract.test.mjs']];
runs.unshift(['--test','../../packages/assistant-runtime/test/voice-interaction.test.mjs','scripts/Smoke-TaskFollow.mjs','../../packages/assistant-runtime/test/listening-lifecycle.test.mjs','../../packages/assistant-runtime/test/speech-playback.test.mjs']);
runs.push(['--import','../../scripts/test-manager-runtime-env.mjs','--import','tsx','--test','scripts/Smoke-DeviceAgentRecoveryHttp.mjs','scripts/Smoke-AiuiApiDiscoveryHttp.mjs']);
for (const args of runs) {
  const result = spawnSync(process.execPath,args,{cwd,stdio:'inherit',timeout:120000});
  if (result.error || result.status !== 0) { console.error('Agent regression failed:',args.join(' ')); process.exit(result.status || 1); }
}
console.log('AIUI Agent regression entry passed.');

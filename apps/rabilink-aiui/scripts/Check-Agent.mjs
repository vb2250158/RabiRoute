import { spawnSync } from 'node:child_process';
import path from 'node:path';
const cwd = path.resolve(import.meta.dirname, '..');
const smoke = ['Smoke-AgentProfile.mjs','Smoke-AgentProfilePage.mjs','Smoke-RabiLinkChatGeneration.mjs','Smoke-AgentRuntimeMode.mjs','Smoke-KnowledgeToolPage.mjs','Smoke-KnowledgeToolRuntime.mjs','Smoke-KnowledgeResultView.mjs','Smoke-RabiLinkVoiceRuntime.mjs','Smoke-RabiLinkAiuiStartupSafety.mjs'];
const runs = [...smoke.map(name => [path.join('scripts',name)]), ['--test','scripts/webgui-coverage.test.mjs','scripts/config-surface-contract.test.mjs','scripts/rokid-status-contract.test.mjs']];
for (const args of runs) {
  const result = spawnSync(process.execPath,args,{cwd,stdio:'inherit',timeout:120000});
  if (result.error || result.status !== 0) { console.error('Agent regression failed:',args.join(' ')); process.exit(result.status || 1); }
}
console.log('AIUI Agent regression entry passed.');

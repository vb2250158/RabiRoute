import type { AgentAdapterCatalogMetadata } from '../pluginRenderers';
import type { PersonaChatReply } from '@shared/personaChatHistory';

const providerAliases:Readonly<Record<string,string>>={
  'codex-desktop':'codex', 'codexDesktop':'codex', 'codexApp':'codex',
  'copilot-cli':'copilotCli', 'grok-bot':'grokBot', 'device-agent':'deviceAgent'
};
type AvatarCatalogEntry=Pick<AgentAdapterCatalogMetadata,'title'|'icon'|'avatarUrl'>&{type:string};
/** Provider aliases are display-only; task ownership and delivery keys remain untouched. */
export function agentAvatarPresentation(provider:string|undefined,catalog:readonly AvatarCatalogEntry[]){
  const type=provider ? providerAliases[provider]??provider : undefined;
  const entry=type?catalog.find(row=>row.type===type):undefined;
  return {type,label:entry?.title??type??'',url:entry?.avatarUrl,icon:entry?.icon??'mdi-robot-outline'};
}
export function historyMessageAgentProvider(entry:PersonaChatReply):string|undefined {
  if(entry.kind==='user_delivery'||entry.kind==='aiui_user')return undefined;
  // The saved-history contract uses Codex for legacy local tasks without an owner.
  return entry.sourceTaskOwner?.provider??'codex';
}

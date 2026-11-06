import assert from 'node:assert/strict';
import test from 'node:test';
import {agentAvatarPresentation,historyMessageAgentProvider} from '../src/agentAdapters/agentAvatarPresentation';
import {registerAgentAdapterRenderer} from '../src/agentAdapters/registerAgentAdapterRenderer';
import {registerTrustedWebSettingsRenderer,resolveWebSettingsCatalog} from '../src/pluginRenderers';
import type {PersonaChatReply} from '../../src/shared/personaChatHistory';

test('history avatars follow provider identity, never a title or another participant',()=>{
  const catalog=[{type:'codex',title:'Codex',icon:'mdi-robot',avatarUrl:'/codex.png'},
    {type:'workbuddy',title:'WorkBuddy',icon:'mdi-robot',avatarUrl:'/workbuddy.png'}];
  assert.equal(agentAvatarPresentation('codex-desktop',catalog).url,'/codex.png');
  assert.equal(agentAvatarPresentation('workbuddy',catalog).url,'/workbuddy.png');
  assert.equal(agentAvatarPresentation('unknown-agent',catalog).url,undefined);
  assert.equal(agentAvatarPresentation(undefined,catalog).url,undefined);
  const entry:PersonaChatReply={id:'1',sessionId:'one',receivedAt:'2026-01-01',text:'WorkBuddy named task',kind:'agent_delivery',
    sourceTaskOwner:{kind:'instance',provider:'codex-desktop',agentId:'a'},targetTaskOwner:{kind:'instance',provider:'workbuddy',agentId:'b'}};
  assert.equal(historyMessageAgentProvider(entry),'codex-desktop');
  assert.equal(historyMessageAgentProvider({...entry,kind:'user_delivery'}),undefined);
  assert.equal(historyMessageAgentProvider({...entry,kind:'aiui_user'}),undefined);
  assert.equal(historyMessageAgentProvider({...entry,sourceTaskOwner:undefined}),'codex');
  assert.equal(agentAvatarPresentation('codex',[]).url,undefined);
});

test('avatar artwork comes from the trusted bundle registration, not server contribution metadata',t=>{
  const dispose=registerAgentAdapterRenderer({registerSettingsRenderer:input=>registerTrustedWebSettingsRenderer({...input,instanceId:'agent:art',pluginId:'io.test.art'})},
    'art',async()=>({render:()=>null}),undefined,undefined,'/assets/owned-icon.png');t.after(dispose);
  const contribution={instanceId:'agent:art',pluginId:'io.test.art',id:'art',kind:'agent-adapter-settings',hosts:['web'],surface:'route.adapters',slot:'art',agentType:'art',capability:'agent.adapter.art@1',rendererId:'agent.art.card.v1',schemaId:'agent.art.route.v1',readCommandId:'agent.art.route.read',writeCommandId:'agent.art.route.write',catalog:{title:'Art',note:'Art software',icon:'mdi-robot',order:1,location:'local',hasCwd:false,hasThread:false,avatarUrl:'https://untrusted.example/icon'}};
  assert.equal(resolveWebSettingsCatalog([contribution])[0]?.agentCatalog?.avatarUrl,'/assets/owned-icon.png');
  dispose();assert.equal(resolveWebSettingsCatalog([contribution]).length,0);
});

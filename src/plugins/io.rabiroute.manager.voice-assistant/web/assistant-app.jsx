import React from 'react';
import {createRoot} from 'react-dom/client';
import {createAssistantPanel} from '../../../../packages/assistant-runtime/ui/assistant-panel.js';

const h=React.createElement;
export function HostSettings({state,settingsTab,speechKind,command,dirty}){
  const current=state?.hostSettings;if(!current)return null;
  const problem=current.lastError?h('details',{className:'va-host-problem'},h('summary',null,'上次宿主操作未完成 · 查看详情'),h('p',null,current.lastError.operationId),h('p',null,[current.lastError.statusCode?'HTTP '+current.lastError.statusCode:'',current.lastError.errorCode].filter(Boolean).join(' · ')),current.lastError.repair&&h('p',null,current.lastError.repair)):null;
  const update=patch=>command({action:'host-settings',patch},patch.personaId!==undefined?'人格已切换，切回时继续原历史。':patch.wakeEnabled!==undefined?'唤醒设置已保存。':'语音服务设置已保存。');
  const selector=(label,value,values,change)=>h('label',{className:'rabi-host-setting'},label,h('select',{value,disabled:dirty||state.context?.busy,onChange:event=>void change(event.target.value)},values.map(([id,title,disabled])=>h('option',{value:id,key:id,disabled},title))));
  if(settingsTab==='conversation')return h('fieldset',null,h('legend',null,'Rabi 人格'),problem,selector('人格',current.personaId,[['','自定义人设'],...current.personas.map(item=>[item.id,item.label])],personaId=>update({personaId})),h('p',null,current.personaId?'系统提示来自所选人格；每个人格分别保存对话历史。切换不会删除记录。':'使用下方的人设与当前对话。'),dirty&&h('p',null,'请先保存当前设置，再切换人格。'));
  if(settingsTab!=='speech')return null;
  const wakeLabels={disabled:'已关闭',starting:'正在启动唤醒',armed:'等待唤醒词',active:'实时对话中','local-fallback':'本机识别接续中',waiting:'等待常驻麦克风',unavailable:'唤醒暂不可用'};
  const kind=speechKind,source=current[kind+'Source'],model=current[kind+'Model'],selected=current.models.find(item=>item.id===model);
  const nativeCapabilities=selected&&h('section',null,h('h3',null,'本机模型能力'),h('div',{className:'va-capabilities'},(selected.features||[]).map(id=>h('span',{key:id,className:'va-capability-chip'},id))),h('details',null,h('summary',null,'服务声明的输入参数'),(selected.requestFields||[]).map(field=>h('details',{key:field.id},h('summary',null,field.id),h('p',null,field.description||'本机服务未提供此参数的详细说明。')))),kind==='tts'&&h(React.Fragment,null,h('h3',null,'Agent 可动态使用'),h('p',null,state.speechExpression?.fields?.map(field=>field.label).join('、')||'当前宿主接口没有已适配的动态表达参数。'),Boolean(state.speechExpression?.fields?.length)&&h('label',null,h('input',{type:'checkbox',checked:Boolean(state.settings.ttsDynamicExpression),onChange:event=>command({action:'settings',patch:{ttsDynamicExpression:event.target.checked}},'动态表达设置已保存。')}),'根据人设与当前情境动态表达')));
  const wakeSetting=kind==='asr'&&h(React.Fragment,null,
    selector('启动模式',current.wakeEnabled?'keyword':'manual',[['manual','手动开始'],['keyword','手动或关键词唤醒',!current.personaId]],value=>update({wakeEnabled:value==='keyword'})),
    h('p',{className:'va-note'},source==='host'?'唤醒后使用所选本机模型。':'唤醒后使用下方保存的提供商和模型。首句识别失败时，本机模型会接着转写。'),
    h('p',{role:'status'},state.settings?.voiceEnabled===false?'语音助手已关闭。':current.wakeEnabled?(wakeLabels[current.wake?.phase]||'正在准备'):'要使用关键词唤醒，请选择人格、添加唤醒词，并开启常驻麦克风。'));
  return h('fieldset',{className:'rabi-host-source'},h('legend',null,kind==='asr'?'识别服务来源':'播报服务来源'),problem,selector('来源',source,[['host','本机服务 · Rabi 当前配置'],['custom','自定义提供商']],value=>update({[kind+'Source']:value})),wakeSetting,source==='host'&&h(React.Fragment,null,
    selector('模型',model,[['','选择本机模型'],...(model&&(!selected?.enabled||!selected?.available)?[[model,(selected?.name||model)+' · 不可用',true]]:[]),...current.models.filter(item=>item.capability===kind&&item.enabled&&item.available).map(item=>[item.id,item.name||item.id])],value=>update({[kind+'Model']:value})),
    h('p',{role:'status'},current[kind+'Issue']||(current.modelsError?'无法连接 Rabi 当前语音服务，请到“语音服务”检查。':!model?'请选择可用模型。':kind==='tts'&&!current.voiceReady?'所选人格尚无本机声线，可配置人格声线或改用自定义播报。':kind==='tts'?'音色来自人格：'+(current.personaLabel||current.personaId||'未选择人格'):'复用 Rabi 当前识别服务。')),
    nativeCapabilities,h('p',null,'麦克风和播放仍由同一助手循环管理。')),dirty&&h('p',null,'请先保存当前设置，再切换服务来源。'));
}
export function SettingsPage({children,title,onClose,open}){if(!open)return null;return h('section',{className:'rabi-assistant-settings'},h('div',{className:'rabi-settings-heading'},h('h2',null,title),h('button',{onClick:onClose},'返回对话')),children)}
export const Panel=createAssistantPanel(React,{Modal:SettingsPage,HostSettings,settingsPresentation:'page'});
export function mountAssistantPanel(element,{fetcher=fetch,resolveAvatarUrl}={}){
  const request=async(action,body)=>{const response=await fetcher('/api/voice-assistant/'+action,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});let value;try{value=await response.json()}catch{throw Error('ASSISTANT_PLUGIN_UNAVAILABLE')}if(!response.ok||value.code!==0)throw Error(value.message||'ASSISTANT_PLUGIN_UNAVAILABLE');return value.data};
  const adapter={read:async()=>{
    const state=await request('state'),id=state.hostSettings?.personaId;
    // The selected persona's existing public resource endpoint also serves the message-history page.
    return id?{...state,participants:{...state.participants,assistant:{name:state.hostSettings.personaLabel||state.settings.assistantName,avatarUrl:'/api/roles/'+encodeURIComponent(id)+'/avatar'}}}:state;
  },command:body=>request('command',body),resolveAvatarUrl,subscribeConversation(_id,listener,onError){let closed=false,timer;const poll=async()=>{try{const data=await request('messages');if(!closed)listener(data)}catch(error){if(!closed)onError(error)}finally{if(!closed)timer=setTimeout(poll,350)}};void poll();return()=>{closed=true;clearTimeout(timer)}}};
  const root=createRoot(element);root.render(h(React.Fragment,null,h('style',null,'.rabi-host-setting{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}.rabi-host-setting select{min-height:42px;border:1px solid #527080;border-radius:8px;padding:8px}.rabi-assistant-settings{width:100%}.rabi-settings-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}'),h(Panel,{adapter})));
  return()=>root.unmount();
}

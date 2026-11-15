import test from 'node:test';import assert from 'node:assert/strict';
import {assistantLiveState,distinctModelLabels,createAssistantPanel} from '@rabilink/assistant-runtime/ui';
import {initialAssistantSettings} from '@rabilink/desktop-voice-service/settings';
import {volcanoCatalog} from '@rabilink/desktop-voice-service/speech-catalog';
import {openSettingsStore} from '../src/settings-store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';

test('live paused and duplex states are independent of old successful tests',()=>{
 const state={voice:{phase:'running',capture:'stopped'},diagnostics:{checks:{voice:{status:'passed'}}}};
 assert.equal(assistantLiveState(state).action,'resume');assert.equal(assistantLiveState(state).listening,false);
 assert.match(assistantLiveState(state).title,/暂停/);
 state.voice.capture='listening';state.interaction={outputActive:true};
 assert.equal(assistantLiveState(state).action,'pause');assert.match(assistantLiveState(state).detail,/打断/);
 state.interaction.outputActive=false;state.activity={status:'responding'};
 assert.equal(assistantLiveState(state).working,true);assert.equal(assistantLiveState(state).listening,true);
 assert.match(assistantLiveState(state,true).title,/断开/);
});
test('home has no setup or diagnostics panel and only one current primary microphone action',()=>{
 let index=0;const state={settings:initialAssistantSettings(),voice:{phase:'running',capture:'stopped',outputEnabled:true},capabilities:{host:'standalone',serviceTests:true},diagnostics:{checks:{}},pet:{}};
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>[index++===0?state:value,()=>{}],useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};
 const tree=createAssistantPanel(react,{Modal:'modal'})({adapter:{}});
 const flat=[];function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return}flat.push(node);if(node.tag!=='modal')node.children?.forEach(visit)}visit(tree);
 assert.ok(!flat.some(node=>node.props.className==='va-checks'||node.props.className==='va-setup'));
 assert.ok(flat.some(node=>node.tag==='button'&&node.children.includes('继续收音')));
 assert.ok(!flat.some(node=>node.tag==='button'&&node.children.includes('开启语音')));
 assert.ok(flat.some(node=>node.props.role==='log'));
});
test('duplicate model names expose their actual variant IDs',()=>{
 assert.deepEqual(distinctModelLabels([{id:'a',label:'Hy3'},{id:'b',label:'Hy3'},{id:'c',label:'other'}]).map(x=>x.label),['Hy3 · a','Hy3 · b','other']);
});
test('first-use completion and voice favorites persist through the settings owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-onboarding-'));try{
 const store=await openSettingsStore(dir);assert.equal(store.read().onboardingComplete,false);
 await store.save({onboardingComplete:true,voiceFavorites:'["volcengine:seed-tts-2.0:voice"]'});
 const restored=await openSettingsStore(dir);assert.equal(restored.read().onboardingComplete,true);assert.equal(JSON.parse(restored.read().voiceFavorites).length,1);
 await assert.rejects(store.save({voiceFavorites:'{}'}),/ASSISTANT_SETTINGS_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('streaming speech has inline live text and no waveform or manual submit, while utterance mode has waveform',()=>{
 for(const mode of ['streaming','utterance']){
 let index=0;const state={settings:initialAssistantSettings(),voice:{phase:'running',capture:'listening',outputEnabled:true},capabilities:{host:'standalone'},pet:{},asrFeedback:mode,inputPreview:{text:'正在说的话',final:false},interaction:{outputActive:true},activity:{status:'responding'}};
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>[index++===0?state:value,()=>{}],useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};
 const tree=createAssistantPanel(react,{Modal:'modal'})({adapter:{}}),nodes=[];function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);nodes.push(v);if(v.tag!=='modal')v.children?.forEach(walk)}walk(tree);
 assert.ok(!nodes.some(v=>v.tag==='button'&&v.children.includes('修改后发送')));
 assert.equal(nodes.some(v=>v.props.className==='va-waveform'),mode==='utterance');
 if(mode==='streaming')assert.ok(nodes.some(v=>v.props.className==='va-live-input'));
 }
});
test('speech settings expose user ASR controls and Agent TTS capabilities without editable expression fields',()=>{
 const draft={...initialAssistantSettings(),asrMode:'volcengine',ttsProvider:'volcengine',ttsModel:'seed-tts-2.0',ttsVoice:'zh_female_tuanzi_uranus_bigtts'};
 const state={settings:draft,voice:{phase:'stopped'},speechCatalogs:{volcengine:volcanoCatalog},speechExpression:{available:true},capabilities:{host:'standalone'},pet:{}};
 let index=0;const overrides={0:state,5:true,6:draft,10:'speech',14:'tts'};
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>{const i=index++;return [Object.hasOwn(overrides,i)?overrides[i]:value,()=>{}]},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};
 const tree=createAssistantPanel(react,{Modal:'modal'})({adapter:{}}),nodes=[];
 function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);nodes.push(v);v.children?.forEach(walk)}walk(tree);
 assert.ok(nodes.some(v=>v.tag==='section'&&v.props['aria-label']==='助手语音表达'));
 assert.ok(nodes.some(v=>v.tag==='label'&&v.children.includes('让助手自动控制语气')));
 const inputLabels=nodes.filter(v=>['input','select','textarea'].includes(v.tag)).map(v=>v.props['aria-label']);
 assert.ok(inputLabels.includes('VAD 静音判停（毫秒）'));
 assert.ok(!inputLabels.includes('语音风格提示词'));assert.ok(!inputLabels.includes('情绪'));assert.ok(!inputLabels.includes('情绪强度'));
 assert.ok(nodes.some(v=>v.tag==='td'&&v.children.includes('Agent 本次播报')));
 assert.ok(nodes.some(v=>v.props.help?.label==='情绪向量'&&v.props.status==='unavailable'&&v.props.statusLabel==='接口未声明'));
});
import {openaiCatalog,speechExpressionPolicy} from '@rabilink/desktop-voice-service/expression';
function capabilityPanel(config,available=true){
 const state={settings:config,voice:{phase:'stopped'},speechCatalogs:{volcengine:volcanoCatalog,compatible:openaiCatalog},speechExpression:{available},capabilities:{host:'standalone'},pet:{}};
 let index=0;const overrides={0:state,5:true,6:config,10:'speech',14:'tts'};
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>{const i=index++;return[Object.hasOwn(overrides,i)?overrides[i]:value,()=>{}]},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};
 const tree=createAssistantPanel(react,{Modal:'modal'})({adapter:{}}),nodes=[];
 function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);nodes.push(v);v.children?.forEach(walk)}walk(tree);return nodes;
}
test('model capability badges are beside selection, match actual Agent policy and never become manual inputs',()=>{
 const emotional=volcanoCatalog.tts.voices.find(v=>v.bidirectional&&v.emotions.length>0);
 for(const selection of [
  {ttsProvider:'volcengine',ttsModel:'seed-tts-2.0',ttsVoice:'zh_female_tuanzi_uranus_bigtts'},
  {ttsProvider:'volcengine',ttsModel:emotional.model,ttsVoice:emotional.id},
  {ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral'},
  {ttsModel:'tts-1',ttsVoice:'alloy'},
 ]){
  const config={...initialAssistantSettings(),ttsDynamicExpression:true,...selection},nodes=capabilityPanel(config);
  const badges=nodes.filter(v=>v.props['data-agent-capability']);
  assert.deepEqual(badges.filter(v=>v.props['data-status']==='available').map(v=>v.props['data-agent-capability']).sort(),speechExpressionPolicy(config).fields.map(v=>v.id).sort());
  const region=nodes.findIndex(v=>v.props['aria-label']==='所选模型的 Agent 能力');
  assert.ok(region>nodes.findIndex(v=>v.tag==='select'&&v.props['aria-label']==='tts 模型'));
  assert.ok(nodes.some(v=>v.props['aria-label']==='声音选择')); // Capabilities stay beside model selection on wide screens.
  assert.equal(nodes.filter(v=>v.tag==='h3'&&v.children.includes('支持 Agent 使用的能力')).length,1);
  assert.ok(!nodes.some(v=>['input','textarea'].includes(v.tag)&&['语音风格提示词','情绪','情绪强度'].includes(v.props['aria-label'])));
 }
});
test('unknown models, custom origins, missing voices and unwired hosts cannot advertise callable Agent extras',()=>{
 const base={...initialAssistantSettings(),ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral',ttsDynamicExpression:true};
 for(const [config,available] of [[{...base,ttsModel:'unknown'},true],[{...base,ttsModel:''},true],[{...base,ttsVoice:''},true],[{...base,ttsEndpoint:'https://custom.test/v1/audio/speech'},true],[base,false]]){
  const nodes=capabilityPanel(config,available),badges=nodes.filter(v=>v.props['data-agent-capability']);
  assert.equal(badges.some(v=>v.props['data-status']==='available'),false);
  if(!available)assert.ok(nodes.some(v=>v.props.status==='metadata'&&v.props.reason==='宿主未接通'));
 }
});
import {recognitionRows,speechParameterRows,createMessageDetailsView} from '@rabilink/assistant-runtime/ui';
test('message details distinguish requested missing values and show actual TTS parameters in readable rows',()=>{
 const rows=recognitionRows({features:[{key:'asrEnableEmotionDetection'},{key:'asrEnableGenderDetection'}],result:{additions:{emotion:'happy',emotion_score:'0.88'}}});
 assert.equal(rows.find(r=>r.key==='emotion').value,'开心');assert.equal(rows.find(r=>r.key==='gender').value,'已请求，接口未返回');assert.ok(!rows.some(r=>r.key==='age'));
 const parameters=speechParameterRows({speaker:'voice',audio_params:{speech_rate:-5,sample_rate:24000},additions:'{"context_texts":["轻声安慰"]}'});
 assert.equal(parameters.find(r=>r.key==='audio_params.speech_rate').value,'0.95 倍（接口值 -5）');assert.equal(parameters.find(r=>r.key==='additions.context_texts').value,'轻声安慰');
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>[value,()=>{}],Fragment:'fragment'},view=createMessageDetailsView(react);
 const tree=view({data:{kind:'asr',message:{text:'你好'},features:[{key:'asrEnableEmotionDetection',label:'情绪检测'}],result:{additions:{emotion:'sad'}}},catalogs:{}});const text=JSON.stringify(tree);
 assert.ok(text.includes('悲伤'));assert.ok(text.includes('返回对话'));assert.ok(text.includes('查看本次接口数据'));
});

test('full page settings replace the chat surface and speech bubbles expose a details action',()=>{
 const state={settings:initialAssistantSettings(),voice:{phase:'stopped'},capabilities:{host:'standalone'},pet:{}};
 const render=(overrides)=>{let index=0;const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>{const i=index++;return[Object.hasOwn(overrides,i)?overrides[i]:value,()=>{}]},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};return createAssistantPanel(react,{Modal:'settings-page',settingsPresentation:'page'})({adapter:{}})};
 const settings=JSON.stringify(render({0:state,5:true,6:state.settings}));assert.match(settings,/va-full-page/);assert.match(settings,/settings-page/);assert.ok(!settings.includes('输入消息，按 Enter 发送'));
 const chat=JSON.stringify(render({0:state,1:[{id:'voice-1',role:'user',text:'你好',source:'speech',hasDetails:true}]}));assert.match(chat,/查看语音识别详情/);assert.ok(!chat.includes('情绪评分'));
});

test('context controls are host-capability based and clearing explains the actual storage owner',()=>{
 const render=(storage,busy=false)=>{const state={settings:initialAssistantSettings(),voice:{phase:'stopped'},context:{storage,status:'ready',busy,messageCount:4,contextMessageCount:4},capabilities:{host:storage==='native'?'dsh':'standalone',contextManagement:true},pet:{}};let index=0;const overrides={0:state,32:true};const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>{const i=index++;return[Object.hasOwn(overrides,i)?overrides[i]:value,()=>{}]},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};return createAssistantPanel(react,{Modal:'settings-page'})({adapter:{}})};
 const local=JSON.stringify(render('local')),native=JSON.stringify(render('native'));assert.match(local,/清空当前聊天记录和模型上下文/);assert.match(native,/原记录由宿主管理/);assert.ok(!native.includes('长期记忆保持不变'));
 const tree=render('local',true),nodes=[];function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);nodes.push(v);v.children?.forEach(walk)}walk(tree);assert.equal(nodes.find(v=>v.tag==='button'&&v.children.includes('确认清除')).props.disabled,true);
});

test('ASR separates enabled capability switches from user preferences and automatic input fields',()=>{
 const config={...initialAssistantSettings(),asrMode:'volcengine',asrModel:'bigmodel'},state={settings:config,voice:{phase:'stopped'},speechCatalogs:{volcengine:volcanoCatalog},capabilities:{host:'standalone'},pet:{}};let index=0;const overrides={0:state,5:true,6:config,10:'speech',14:'asr'};
 const react={createElement:(tag,props,...children)=>({tag,props:props||{},children}),useState:value=>{const i=index++;return[Object.hasOwn(overrides,i)?overrides[i]:value,()=>{}]},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},Fragment:'fragment'};const tree=createAssistantPanel(react,{Modal:'modal'})({adapter:{}}),nodes=[];function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);nodes.push(v);v.children?.forEach(walk)}walk(tree);
 for(const key of ['asrEnableEmotionDetection','asrEnableAgeDetection','asrEnableGenderDetection','asrUseContext'])assert.ok(nodes.some(node=>node.props['data-asr-capability']===key));assert.ok(!nodes.some(node=>['textarea','input','select'].includes(node.tag)&&['辅助上下文','返回结果方式'].includes(node.props['aria-label'])));assert.ok(nodes.some(node=>node.props['aria-label']==='启用情绪检测'&&node.props.checked===true));assert.ok(nodes.some(node=>node.tag==='input'&&node.props.type==='checkbox'&&node.props.checked===false));
});

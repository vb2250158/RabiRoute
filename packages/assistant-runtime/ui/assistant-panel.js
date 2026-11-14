/** Optional shared presenter. No capture, playback, model loop, or owner teardown. */
import { assistantPanelStyles } from './assistant-panel-styles.js'
const settingsDelta=(value,base)=>Object.fromEntries(Object.entries(value).filter(([key,item])=>!['speechProfiles','llmProfiles'].includes(key)&&item!==base?.[key]))
export function assistantSetupGaps(state){
  if(!state)return []
  const config=state.settings||{},gaps=[]
  const hostModels=state.capabilities?.hostModels
  const hasHostModel=state.selectedModel?.model&&(!Array.isArray(hostModels)||hostModels.some(item=>item.provider===state.selectedModel.provider&&item.model===state.selectedModel.model))
  if(state.capabilities?.host==='standalone'?!config.llmModel:!hasHostModel)gaps.push({section:'conversation',label:'选择对话模型'})
  if(config.asrMode!=='native'&&!config.asrModel)gaps.push({section:'asr',label:'选择识别模型'})
  if(config.asrMode==='volcengine'&&state.credentials?.asr?.configured===false)gaps.push({section:'asr',label:'填写识别密钥'})
  if(!config.ttsModel||!config.ttsVoice)gaps.push({section:'tts',label:!config.ttsModel?'选择播报模型':'选择播报音色'})
  if(config.ttsProvider==='volcengine'&&state.credentials?.tts?.configured===false)gaps.push({section:'tts',label:'填写播报密钥'})
  return gaps
}
export function speechFieldError(spec,value){
  if(spec.type==='number'){
    if(value===''||typeof value!=='number'||!Number.isFinite(value))return '请填写数值。'
    if(spec.integer&&!Number.isInteger(value))return '请填写整数。'
    if(spec.min!==undefined&&value<spec.min)return '不能小于 '+spec.min+'。'
    if(spec.max!==undefined&&value>spec.max)return '不能大于 '+spec.max+'。'
  }
  if(spec.maxLength&&String(value).length>spec.maxLength)return '最多 '+spec.maxLength+' 个字符。'
  return ''
}
export function createAssistantPanel(React, { Button = 'button', Input = 'input', Modal }) {
  const h = React.createElement
  const layout = { display:'flex', flexDirection:'column', gap:12, padding:16, maxWidth:1000, margin:'0 auto', color:'var(--dsw-alias-text-primary, inherit)' }
  const row = { display:'flex', flexWrap:'wrap', gap:8, alignItems:'center' }
  const label = { display:'flex', flexDirection:'column', gap:6, marginBottom:12 }
  const errors = {
    'Failed to fetch':'与本机助手的连接已断开，请确认后台服务正在运行后重试。',
    MODEL_CATALOG_HTTP_401:'模型列表认证失败，请保存当前提供商的密钥后重试。',
    MODEL_CATALOG_UNAVAILABLE:'这个接口不提供模型列表，可手动填写模型名。',
    MODEL_CREDENTIAL_PROVIDER_MISMATCH:'这把密钥与当前提供商不匹配，请先选择正确的提供商。',
    SPEECH_TTS_MODEL_REQUIRED:'请在设置中填写播报模型和音色。', SPEECH_ASR_MODEL_REQUIRED:'请在设置中填写识别模型。',
    ASSISTANT_STOP_VOICE_BEFORE_TEST:'请先停止语音，再进行设备测试。', ASSISTANT_DEVICE_TEST_BUSY:'设备测试正在进行，请稍候。',
    DEVICE_START_TIMEOUT:'音频进程启动超时。', DEVICE_CAPTURE_INTERRUPTED:'麦克风采集已中断，请检查设备。',
    RESIDENT_CLEANUP_UNCONFIRMED:'旧音频资源尚未确认释放，暂不能再次开启。',
    ASSISTANT_PRESET_COMPLETE_PROMPT:'当前 DSH 默认预设锁定了完整系统提示词，无法应用可编辑人设。请在 DSH 预设中关闭完整提示词模式后重试。',
    SPEECH_NATIVE_UNAVAILABLE:'当前宿主尚未启用原生识别服务。请配置识别服务，或选择其它提供商；文字仍可使用。',
    ASSISTANT_MODEL_REQUIRED:'请在设置中选择对话模型。',
    SPEECH_PROVIDER_HTTP_403:'语音服务拒绝访问所选资源。请核对当前模型、计费资源是否已开通，以及该密钥是否有使用权限。',
    SPEECH_PROVIDER_HTTP_401:'语音服务未通过认证。请核对当前提供商、接口地址和 API Key。',
    ASSISTANT_MODEL_HTTP_401:'对话服务未通过认证。请核对模型接口与 API Key。',
    SPEECH_CREDENTIAL_TARGET_CHANGED:'提供商或接口地址已变化，请刷新设置后重新保存密钥。',
  }
  return function AssistantPanel({ adapter }) {
    const [state,setState] = React.useState(null), [messages,setMessages] = React.useState([])
    const [message,setMessage] = React.useState(''), [text,setText] = React.useState(''), [pending,setPending] = React.useState(null)
    const [editing,setEditing] = React.useState(false), [draft,setDraft] = React.useState({}), [devices,setDevices] = React.useState([])
    const [keys,setKeys] = React.useState({asr:'',tts:'',llm:''}), [busy,setBusy] = React.useState(false)
    const [settingsTab,setSettingsTab]=React.useState('conversation'),[catalogs,setCatalogs]=React.useState({}),[manual,setManual]=React.useState({}),[hostProvider,setHostProvider]=React.useState('')
    const [speechKind,setSpeechKind]=React.useState('asr'),[parameterSearch,setParameterSearch]=React.useState(''),[voiceSearch,setVoiceSearch]=React.useState(''),[manualVoice,setManualVoice]=React.useState(false)
    const [showIdentifiers,setShowIdentifiers]=React.useState(false),[closePrompt,setClosePrompt]=React.useState(false)
    const [draftBase,setDraftBase]=React.useState({}),[draftPatches,setDraftPatches]=React.useState([]),[draftCredentials,setDraftCredentials]=React.useState(null)
    const [connectionError,setConnectionError]=React.useState(false)
    const preview=Boolean(state?.capabilities?.preview)
    const conversationMissing=assistantSetupGaps(state).some(item=>item.section==='conversation')
    const pages=React.useRef(null)
    const mounted = React.useRef(false)
    const report = error => { if (mounted.current) setMessage(errors[error.message] || '操作未确认：' + error.message) }
    const refresh = async () => { try{const next = await adapter.read(); if(mounted.current){setState(next);setConnectionError(false)}return next}catch(error){if(mounted.current)setConnectionError(true);throw error} }
    React.useEffect(() => {
      mounted.current=true; let timer, cancelled=false
      const poll=async()=>{try{await refresh()}catch(error){report(error)}finally{if(!cancelled)timer=setTimeout(poll,700)}}
      void adapter.command({action:'prepare'}).then(poll, error=>{report(error);void poll()})
      return ()=>{mounted.current=false;cancelled=true;clearTimeout(timer)}
    },[adapter])
    React.useEffect(()=>{
      if(!state?.sessionId)return
      return adapter.subscribeConversation(state.sessionId, value=>{if(mounted.current)setMessages(value)},report)
    },[adapter,state?.sessionId])
    const command=async(request,feedback)=>{
      setBusy(true)
      try{const result=await adapter.command(request);await refresh();if(mounted.current&&feedback)setMessage(typeof feedback==='function'?feedback(result):feedback);return result}
      catch(error){report(error);throw error}finally{if(mounted.current)setBusy(false)}
    }
    const invoke=(request,feedback)=>{void command(request,feedback).catch(()=>{})}
    const send=async()=>{
      if(preview||conversationMissing||busy||!state||connectionError||!text.trim()&&!pending)return
      const request=pending||{action:'text',text,requestId:crypto.randomUUID()}
      setMessage('')
      setPending(request)
      try{await command(request);if(mounted.current){setPending(null);setText('')}}catch{}
    }
    const dirty=draftPatches.length>0||Object.keys(settingsDelta(draft,draftBase)).length>0||Object.values(keys).some(Boolean)
    const pendingPatches=()=>{const delta=settingsDelta(draft,draftBase);return [...draftPatches,...(Object.keys(delta).length?[delta]:[])]}
    const closeSettings=()=>{setEditing(false);setClosePrompt(false);setKeys({asr:'',tts:'',llm:''})}
    const requestClose=()=>{if(busy)return;if(dirty)setClosePrompt(true);else closeSettings()}
    const openSettings=(section)=>{setDraft({...state.settings});setDraftBase({...state.settings});setDraftPatches([]);setDraftCredentials(null);setKeys({asr:'',tts:'',llm:''});setHostProvider('');setMessage('');setClosePrompt(false);if(typeof section==='string')navigateSettings(section);setEditing(true)}
    const navigateSettings=id=>{setSettingsTab(id==='asr'||id==='tts'?'speech':id);if(id==='asr'||id==='tts')setSpeechKind(id);setParameterSearch('');if(pages.current)pages.current.scrollTop=0}
    const previewSelection=async patch=>{
      validateSpeechDraft()
      const patches=[...pendingPatches(),patch]
      if(patches.length>64){setMessage('本轮修改较多，请先保存设置。');return}
      const result=await command({action:'preview-settings',patches})
      setDraft(result.settings);setDraftBase(result.settings);setDraftPatches(patches);setDraftCredentials(result.credentials)
    }
    const commitDraft=async()=>{
      validateSpeechDraft()
      const result=await command(state.settingsDraft?{action:'settings',patches:pendingPatches()}:{action:'settings',patch:settingsDelta(draft,state.settings)})
      setDraft(result.settings);setDraftBase(result.settings);setDraftPatches([]);setDraftCredentials(null)
      for(const kind of ['llm','asr','tts'])if(keys[kind]){
        const config=result.settings,provider=kind==='asr'?config.asrMode:kind==='tts'?config.ttsProvider||'compatible':config.llmProvider||'compatible'
        await command({action:'credential',kind,key:keys[kind],provider,endpoint:config[kind+'Endpoint']});setKeys(current=>({...current,[kind]:''}))
      }
      return result.settings
    }
    const edit=(key,value)=>{setMessage('');setDraft(current=>({...current,[key]:value}))}
    const field=(title,key,type='text')=>h('label',{style:label,key},title,h(Input,{type,value:draft[key]??'',onChange:event=>edit(key,type==='number'?Number(event.target.value):event.target.value),'aria-label':title}))
    const check=(title,key,disabled=false)=>h('label',{style:row,key},h('input',{type:'checkbox',checked:Boolean(draft[key]),disabled,onChange:event=>edit(key,event.target.checked)}),title)
    const select=(title,key,options)=>h('label',{style:label,key},title,h('select',{value:draft[key]??'',onChange:event=>edit(key,event.target.value)},options.map(([value,title])=>h('option',{key:value,value},title))))
    const providerId=kind=>kind==='asr'?draft.asrMode:kind==='tts'?(draft.ttsProvider||'compatible'):(draft.llmProvider||'compatible')
    const dirtyKind=kind=>Object.fromEntries(Object.entries(draft).filter(([key,value])=>key.startsWith(kind)&&!key.endsWith('Profiles')&&value!==state.settings[key]))
    const validateSpeechDraft=kind=>{
      for(const currentKind of kind?[kind]:['asr','tts'])for(const spec of speechCatalog(currentKind)?.parameters||[]){
        if(!enabledParameter(spec))continue
        const error=speechFieldError(spec,draft[spec.key]??spec.default)
        if(error){setSettingsTab('speech');setSpeechKind(currentKind);setParameterSearch(spec.label);setMessage(spec.label+'：'+error);throw Error('SPEECH_FORM_INVALID')}
      }
    }
    const saveConnection=async kind=>dirty?commitDraft():state.settings
    const credentialState=kind=>draft[kind+'Endpoint']!==draftBase[kind+'Endpoint']?{configured:false}:(draftCredentials||state?.credentials)?.[kind]
    const credential=kind=>h('details',{className:'va-credential',open:!credentialState(kind)?.configured||Boolean(keys[kind])},h('summary',null,credentialState(kind)?.configured?'密钥已保存 · 更换':'设置连接密钥'),h('label',{style:label},providerId(kind)==='workbuddy-cn'?'网关密钥':'API Key',h(Input,{type:'password',disabled:preview,autoComplete:'new-password',value:keys[kind]||'',placeholder:credentialState(kind)?.configured?'留空保留已保存密钥':'填写当前提供商的密钥','aria-label':kind+' API Key',onChange:event=>setKeys(current=>({...current,[kind]:event.target.value}))})),h('small',null,keys[kind]?'点击底部“保存设置”后生效；切换提供商会清空未保存密钥。':preview?'预览不接收真实密钥，请在实际助手中配置。':'密钥不会显示在页面上。'))
    const loadModels=async kind=>{try{const config=await saveConnection(kind);const value=await command({action:'models',kind,provider:providerId(kind),endpoint:config[kind+'Endpoint']});setCatalogs(current=>({...current,[kind]:value}));setMessage(preview?'以下为界面示例，未连接提供商，不能用于对话。':value.length?'已读取 '+value.length+' 个模型；请选择后保存，再发送一条消息验证。':'没有返回模型，可手动填写。')}catch{}}
    const modelSelect=kind=>{const values=catalogs[kind]||[],current=draft[kind+'Model']||'';return h('div',{style:label},h('label',{style:label},'模型',manual[kind]?h(Input,{value:current,'aria-label':kind+' 模型',onChange:event=>edit(kind+'Model',event.target.value)}):h('select',{value:current,disabled:busy||!current&&!values.length,'aria-label':kind+' 模型',onChange:event=>edit(kind+'Model',event.target.value)},h('option',{value:''},values.length?'选择模型':'先刷新模型列表'),current&&!values.some(item=>item.id===current)&&h('option',{value:current},current),values.map(item=>h('option',{key:item.id,value:item.id},item.label+(preview?' · 示例，不可调用':''))))),h('div',{style:row},h(Button,{disabled:busy,onClick:()=>void loadModels(kind)},preview?'查看示例模型':dirty?'保存并刷新模型':'刷新模型'),h(Button,{onClick:()=>setManual(current=>({...current,[kind]:!current[kind]}))},manual[kind]?'从列表选择':'手动填写')))}
    const chooseProvider=async(kind,id)=>{
      setMessage('')
      setKeys(current=>({...current,[kind]:''}))
      setCatalogs(current=>({...current,[kind]:[]}))
      const selection=kind==='asr'?'asrMode':kind==='tts'?'ttsProvider':'llmProvider'
      const dirty=dirtyKind(kind)
      try{
        if(state.settingsDraft){await previewSelection({[selection]:id});return}
        validateSpeechDraft(kind)
        if(Object.keys(dirty).length)await command({action:'settings',patch:dirty})
        const result=await command({action:'settings',patch:{[selection]:id}})
        const settings=result.settings
        setDraft(current=>({...current,...Object.fromEntries(Object.entries(settings).filter(([key])=>key.startsWith(kind))),speechProfiles:settings.speechProfiles}));setDraftBase(settings)
      }catch{}
    }
    const providerSelect=kind=>{
      const choices=kind==='llm'?(state?.capabilities?.modelProviders||[{id:'compatible',label:'OpenAI / 兼容服务'}]):state?.capabilities?.speechProviders?.[kind]||(kind==='asr'?[{id:'native',label:'DSH 已配置的识别服务'},{id:'compatible',label:'OpenAI / 兼容服务'}]:[{id:'compatible',label:'OpenAI / 兼容服务'}])
      return h('label',{style:label,className:'va-provider'},'提供商',h('select',{disabled:busy,value:providerId(kind),onChange:event=>void chooseProvider(kind,event.target.value),'aria-label':kind+' 提供商'},choices.map(item=>h('option',{key:item.id,value:item.id},item.label))))
    }
    const hostModels=state?.capabilities?.hostModels||[],hostGroups=[...new Map(hostModels.map(item=>[item.provider,item.providerLabel||item.provider])).entries()]
    const selectedHost=hostProvider||state?.selectedModel?.provider||hostGroups[0]?.[0]||''
    const speechCatalog=kind=>state?.speechCatalogs?.[providerId(kind)]?.[kind]
    const enabledParameter=spec=>(!spec.models||spec.models.includes(draft.ttsModel))
      &&(!spec.requiresExpressive||draft.ttsModel!=='seed-icl-2.0'||draft.ttsVariant==='seed-tts-2.0-expressive')
      &&(!spec.enabledWhen||(spec.enabledWhen.oneOf?spec.enabledWhen.oneOf.includes(draft[spec.enabledWhen.key]):spec.enabledWhen.notEmpty?Boolean(draft[spec.enabledWhen.key]):draft[spec.enabledWhen.key]===spec.enabledWhen.equals))
      &&!spec.disabledWhenAny?.some(key=>draft[key])&&!spec.disabledModes?.includes(draft.asrRecognitionMode)
    const disabledReason=spec=>{
      const fields=[...(speechCatalog('asr')?.parameters||[]),...(speechCatalog('tts')?.parameters||[])],name=key=>fields.find(item=>item.key===key)?.label||key
      if(spec.models&&!spec.models.includes(draft.ttsModel))return '当前模型不支持'
      if(spec.requiresExpressive&&draft.ttsModel==='seed-icl-2.0'&&draft.ttsVariant!=='seed-tts-2.0-expressive')return '需将合成版本切换为“表现力增强版”'
      if(spec.enabledWhen){const rule=spec.enabledWhen;if(rule.equals===true&&!draft[rule.key])return '先开启“'+name(rule.key)+'”';if(rule.notEmpty&&!draft[rule.key])return '先填写“'+name(rule.key)+'”';return '需要调整“'+name(rule.key)+'”'}
      const blocking=spec.disabledWhenAny?.filter(key=>draft[key]);if(blocking?.length)return '与“'+blocking.map(name).join('、')+'”不能同时使用'
      return '当前识别模式不支持'
    }
    const parameterControl=spec=>{
      const enabled=enabledParameter(spec),disabled=busy||!enabled,value=draft[spec.key]??spec.default
      const error=enabled?speechFieldError(spec,value):'',errorId='speech-error-'+spec.key
      const props={'aria-label':spec.label,'aria-invalid':Boolean(error),'aria-describedby':error?errorId:undefined,disabled,value,onChange:event=>edit(spec.key,typeof spec.default==='number'&&event.target.value!==''?Number(event.target.value):event.target.value)}
      let control
      if(spec.type==='boolean')control=h('label',{style:row},h('input',{type:'checkbox',checked:Boolean(value),disabled,onChange:event=>edit(spec.key,event.target.checked)}),spec.label)
      else if(spec.key==='ttsEmotion'&&speechCatalog('tts')?.voices.find(item=>item.id===draft.ttsVoice)){
        const choices=speechCatalog('tts').voices.find(item=>item.id===draft.ttsVoice).emotions
        control=h('label',{style:label},spec.label,h('select',{...props,disabled:disabled||!choices.length},h('option',{value:''},choices.length?'不指定情绪':'此音色未提供情绪标签，请使用风格提示词'),choices.map(item=>h('option',{key:item.id,value:item.id},item.label))))
      }
      else if(spec.type==='select')control=h('label',{style:label},spec.label,h('select',props,spec.options.map(item=>h('option',{key:item.id,value:item.id,disabled:item.supported===false},item.label))))
      else if(spec.type==='vector')control=h('fieldset',null,h('legend',null,spec.label),spec.dimensions.map((dimension,index)=>h('label',{key:dimension.id,style:label},dimension.label,h(Input,{type:'number',min:dimension.min,max:dimension.max,step:dimension.step??.01,disabled,'aria-label':spec.label+' · '+dimension.label,value:value?.[index]??dimension.default??0,onChange:event=>{const next=spec.dimensions.map((item,i)=>value?.[i]??item.default??0);next[index]=Number(event.target.value);edit(spec.key,next)}}))))
      else control=h('label',{style:label},spec.label,h(spec.type==='textarea'?'textarea':Input,{...props,type:spec.type==='number'?'number':'text',min:spec.min,max:spec.max,step:spec.integer?1:'any',maxLength:spec.maxLength,rows:spec.type==='textarea'?3:undefined}))
      return h('div',{key:spec.key,className:'va-parameter'+(['textarea','vector'].includes(spec.type)?' va-parameter-wide':''),'data-enabled':enabled},control,
        error&&h('small',{id:errorId,role:'alert',className:'va-error'},error),
        spec.note&&h('small',{className:'va-note'},spec.note),
        !enabled&&h('small',{className:'va-disabled'},disabledReason(spec)),
        h('small',{className:'va-default'},'默认：'+(spec.default===''?'不指定':typeof spec.default==='boolean'?(spec.default?'开启':'关闭'):String(spec.default))+(spec.min!==undefined?' · 最小 '+spec.min:'')+(spec.max!==undefined?' · 最大 '+spec.max:'')),
        showIdentifiers&&h('code',null,spec.parameter||spec.key))
    }
    const providerParameters=kind=>{
      const catalog=speechCatalog(kind);if(!catalog)return h('p',null,'此服务尚未提供模型参数目录，当前仅支持基本连接配置。')
      const needle=parameterSearch.trim().toLowerCase(),fields=(catalog.parameters||[]).filter(spec=>!needle||[spec.label,spec.key,spec.parameter,spec.group].some(value=>String(value||'').toLowerCase().includes(needle)))
      const groups=[...new Set(fields.map(spec=>spec.group||'其他参数'))]
      return h('div',null,h('div',{className:'va-parameter-toolbar'},h('label',{style:label},'模型参数',h(Input,{value:parameterSearch,placeholder:'搜索功能，如情绪、语速、分句…','aria-label':'搜索模型参数',onChange:event=>setParameterSearch(event.target.value)})),h('label',{className:'va-identifiers'},h('input',{type:'checkbox',checked:showIdentifiers,onChange:event=>setShowIdentifiers(event.target.checked)}),'显示参数名')),
        groups.map(group=>h('details',{key:group,className:'va-group',open:needle?true:undefined},h('summary',null,h('span',null,group),h('span',{className:'va-count'},fields.filter(spec=>(spec.group||'其他参数')===group).length+' 项')),h('div',{className:'va-parameter-grid'},fields.filter(spec=>(spec.group||'其他参数')===group).map(parameterControl)))),
        !fields.length&&h('p',null,'没有匹配的参数。'),h('p',null,h('a',{href:catalog.docs,target:'_blank',rel:'noreferrer'},'官方参数文档'),' · '+catalog.verifiedAt))
    }
    const chooseSpeechSelection=async(kind,patch)=>{
      setMessage('')
      try{if(state.settingsDraft){await previewSelection(patch);return}validateSpeechDraft(kind);const dirty=dirtyKind(kind);if(Object.keys(dirty).length)await command({action:'settings',patch:dirty})
        const result=await command({action:'settings',patch})
        setDraft(current=>({...current,...Object.fromEntries(Object.entries(result.settings).filter(([key])=>key.startsWith(kind)))}));setDraftBase(result.settings)
      }catch{}
    }
    const speechModel=kind=>{
      const catalog=speechCatalog(kind);if(!catalog)return modelSelect(kind)
      const model=catalog.models.find(item=>item.id===draft[kind+'Model'])
      return h('div',{className:'va-model-grid'},h('label',{style:label},'模型',h('select',{value:draft[kind+'Model'],disabled:busy,'aria-label':kind+' 模型',onChange:event=>void chooseSpeechSelection(kind,{[kind+'Model']:event.target.value,...(kind==='tts'?{ttsBilling:'characters'}:{})})},catalog.models.map(item=>h('option',{key:item.id,value:item.id,disabled:!item.supported},item.label+(item.supported?'':' · 尚未接入'))))),
        kind==='asr'&&h('label',{style:label},'识别模式',h('select',{value:draft.asrRecognitionMode||'realtime',disabled:busy,'aria-label':'识别模式',onChange:event=>void chooseSpeechSelection(kind,{asrRecognitionMode:event.target.value})},catalog.modes.map(item=>h('option',{key:item.id,value:item.id},item.label)))),
        h('label',{style:label},'计费资源',h('select',{value:draft[kind+'Billing']||(kind==='asr'?'duration':'characters'),disabled:busy,'aria-label':kind+' 计费资源',onChange:event=>void chooseSpeechSelection(kind,{[kind+'Billing']:event.target.value})},catalog.billing.map(item=>h('option',{key:item.id,value:item.id,disabled:!model?.resources?.[item.id]},item.label)))),
        model?.note&&h('p',null,model.note),h('p',null,kind==='asr'?catalog.modes.find(item=>item.id===(draft.asrRecognitionMode||'realtime'))?.note:catalog.modes.find(item=>item.supported)?.label),
        h('details',null,h('summary',null,'能力与接入状态'),h('p',null,catalog.capabilities.join(' · ')),catalog.models.filter(item=>!item.supported).map(item=>h('p',{key:item.id},item.label+'：'+item.note)),kind==='tts'&&catalog.modes.filter(item=>!item.supported).map(item=>h('p',{key:item.id},item.label+'：'+item.note))))
    }
    const voicePicker=()=>{
      const catalog=speechCatalog('tts');if(!catalog||manualVoice||draft.ttsModel?.startsWith('seed-icl'))return h('div',null,field('音色 ID','ttsVoice'),catalog&&!draft.ttsModel?.startsWith('seed-icl')&&h(Button,{onClick:()=>setManualVoice(false)},'从音色列表选择'))
      const voices=catalog.voices.filter(item=>item.model===draft.ttsModel),needle=voiceSearch.toLowerCase(),filtered=voices.filter(item=>[item.id,item.label,item.languages].some(value=>value.toLowerCase().includes(needle))),selected=voices.find(item=>item.id===draft.ttsVoice)
      return h('div',{className:'va-voice-picker'},h('label',{style:label},'搜索音色',h(Input,{value:voiceSearch,'aria-label':'搜索音色',placeholder:'名称、语言或音色 ID',onChange:event=>setVoiceSearch(event.target.value)})),
        h('label',{style:label},'音色',h('select',{value:draft.ttsVoice||'','aria-label':'音色',onChange:event=>{edit('ttsVoice',event.target.value);edit('ttsEmotion','')}},h('option',{value:''},'选择音色'),draft.ttsVoice&&!filtered.some(item=>item.id===draft.ttsVoice)&&h('option',{value:draft.ttsVoice},selected?.label||draft.ttsVoice),filtered.map(item=>h('option',{key:item.id,value:item.id,disabled:!item.bidirectional},item.label+(item.bidirectional?'':' · 仅单向流'))))),
        h('small',null,needle?'匹配 '+filtered.length+' / '+voices.length+' 个音色':'当前模型 '+voices.length+' 个公共音色'),needle&&!filtered.length&&h('p',{role:'status'},'没有匹配的音色。试试其他名称或语言；当前已选音色仍保留。'),selected&&h('p',null,selected.languages+(selected.instruction?' · 支持风格指令':'')),
        h(Button,{onClick:()=>setManualVoice(true)},'填写专属音色 ID'))
    }
    const connectionDetails=kind=>h('details',{className:'va-advanced'},h('summary',null,'高级连接设置'),h('div',{style:{marginTop:16}},field('接口地址',kind+'Endpoint'),providerId(kind)==='volcengine'&&field('资源 ID',kind+'ResourceId')))
    const saveSettings=async(close=false)=>{try{await commitDraft();setMessage(preview?'示例设置已保存，仅用于预览。':'设置已保存。');if(close)closeSettings()}catch{setClosePrompt(false)}}
    const settingsBody=h('div',{className:'va-settings'},
      preview&&h('div',{className:'va-preview va-preview-settings',role:'status'},h('strong',null,'仅预览设置 · 不能实际对话'),h('span',null,'模型是示例数据，不会连接 WorkBuddy 或其他服务。请勿填写真实密钥。')),
      h('nav',{className:'va-nav','aria-label':'设置分类'},[['conversation','对话'],['asr','语音识别'],['tts','语音播报'],['devices','设备'],['appearance','外观']].map(([id,name])=>h(Button,{key:id,'aria-pressed':settingsTab==='speech'?speechKind===id:settingsTab===id,onClick:()=>navigateSettings(id)},name))),
      h('fieldset',{className:'va-pages',disabled:busy,ref:pages},
      h('div',{hidden:settingsTab!=='conversation',style:{display:settingsTab==='conversation'?'grid':'none',gap:20}},
      state?.capabilities?.host==='standalone'
        ?h('fieldset',null,h('legend',null,'对话模型'),h('p',{className:'va-help'},'1. 选择提供商并填写连接信息。2. 刷新模型列表，选择模型后保存。3. 回到聊天页发送一句话，收到回复后再配置语音。'),providerSelect('llm'),providerId('llm')==='workbuddy-cn'&&h('p',null,'使用已登录国内账号的本地 WorkBuddy 网关。这里填写网关密钥，不是 CodeBuddy CLI 访问密钥。'),credential('llm'),modelSelect('llm'),connectionDetails('llm'))
        :h('fieldset',null,h('legend',null,'DSH 对话模型'),!hostModels.length&&h('p',{role:'status',className:'va-help'},state?.capabilities?.hostModelsError?'未能读取 DSH 模型目录，请点击“刷新模型”重试。':'尚未读到可用模型。请先在 DSH 的模型提供商中完成登录或连接，再回这里刷新。'),h('label',{style:label},'提供商',h('select',{'aria-label':'宿主提供商',value:selectedHost,disabled:busy||!hostGroups.length,onChange:event=>setHostProvider(event.target.value)},hostGroups.map(([id,name])=>h('option',{key:id,value:id},name)))),h('label',{style:label},'模型',h('select',{'aria-label':'宿主模型',value:state?.selectedModel?.provider===selectedHost?state.selectedModel.model:'',disabled:busy||!hostModels.length,onChange:event=>invoke({action:'select-model',provider:selectedHost,model:event.target.value},'模型已切换。')},h('option',{value:'',disabled:true},'选择模型'),hostModels.filter(item=>item.provider===selectedHost).map(item=>h('option',{key:item.model,value:item.model},item.label)))),h(Button,{disabled:busy,onClick:()=>invoke({action:'refresh-models'})},'刷新模型'),h('p',null,'这里自动读取 DSH 已配置的提供商和模型，无需重复填写密钥。选择模型立即生效。'),state?.capabilities?.presets&&select('助手预设','agentPreset',[['','使用默认预设'],...state.capabilities.presets.map(item=>[item.id,item.label])])),
      h('label',{style:label},'人设',h('textarea',{rows:4,value:draft.persona??'',onChange:event=>edit('persona',event.target.value),'aria-label':'人设'})),state?.capabilities?.host!=='standalone'&&check('管理全部工作区的对话','manageAllWorkspaces')),
      h('div',{hidden:settingsTab!=='speech',style:{display:settingsTab==='speech'?'grid':'none',gap:20}},
      h('fieldset',{hidden:speechKind!=='asr',className:'va-service'},h('legend',null,'语音识别'),h('p',{className:'va-help'},'把你说的话转换为文字。选择提供商和模型，填写该服务的密钥后保存；不确定的模型参数保持默认即可。'),h('div',{className:'va-basic-grid'},providerSelect('asr'),draft.asrMode!=='native'&&speechModel('asr')),
        draft.asrMode!=='native'&&h(React.Fragment,null,credential('asr'),providerParameters('asr'),connectionDetails('asr'))),
      h('fieldset',{hidden:speechKind!=='tts',className:'va-service'},h('legend',null,'语音播报'),h('p',{className:'va-help'},'把助手回复读出来。选择提供商、模型和音色，保存后点击“试听播报”；听到声音再开启语音对话。'),h('div',{className:'va-basic-grid'},providerSelect('tts'),speechModel('tts')),voicePicker(),
        speechCatalog('tts')&&h('p',null,h('a',{href:speechCatalog('tts').voiceDocs,target:'_blank',rel:'noreferrer'},'查看官方音色目录')),
        credential('tts'),h(Button,{disabled:preview||busy||!draft.ttsVoice,onClick:()=>void saveConnection('tts').then(()=>command({action:'test-playback'},value=>value.message)).catch(()=>{})},dirty?'保存并试听':'试听播报'),providerParameters('tts'),connectionDetails('tts'))),
      h('div',{hidden:settingsTab!=='devices'},h('fieldset',null,h('legend',null,'音频设备'),
        h(Button,{disabled:busy,onClick:()=>{void command({action:'devices'}).then(value=>setDevices(value)).catch(()=>{})}},'刷新设备'),
        select('麦克风','inputDeviceId',[['','系统默认'],...devices.filter(d=>d.kind==='audioinput').map(d=>[d.id,d.label||'未命名输入设备'])]),
        select('扬声器','outputDeviceId',[['','系统默认'],...devices.filter(d=>d.kind==='audiooutput').map(d=>[d.id,d.label||'未命名输出设备'])]),
        h('div',{style:row},h(Button,{disabled:preview||busy,onClick:()=>void saveConnection().then(()=>command({action:'test-microphone'},result=>result.message)).catch(()=>{})},dirty?'保存并测试麦克风 · 3 秒':'测试麦克风 · 3 秒'))),h('details',null,h('summary',null,'高级设备设置'),field('Electron 可执行文件（留空自动发现）','electronExecutable'),field('识别灵敏度','silenceThreshold','number'),field('句尾等待（毫秒）','silenceDurationMs','number'))),
      h('div',{hidden:settingsTab!=='appearance',style:{display:settingsTab==='appearance'?'grid':'none',gap:20}},
      h('fieldset',null,h('legend',null,'字幕'),check('显示独立字幕','captionsEnabled'),check('锁定位置和大小','captionLocked'),
        select('皮肤','captionSkin',[['dark','深色'],['light','浅色']]),field('字号（16–48）','captionFontSize','number'),field('背景透明度（0.15–1）','captionOpacity','number'),
        select('默认位置','captionPosition',[['bottom','底部'],['top','顶部']]),h(Button,{onClick:()=>setDraft(current=>({...current,captionHasBounds:false,captionPosition:'bottom',captionFontSize:24,captionOpacity:.85,captionLocked:false}))},'恢复字幕样式与位置')),
      h('fieldset',null,h('legend',null,'桌宠'),check('联动桌宠','petEnabled',!state?.pet.available),check('显示气泡','petBubbles',!state?.pet.available),check('播放动画','petAnimation',!state?.pet.available),
        state?.pet.available&&select('桌宠','petId',[['','选择桌宠'],...(state.pet.pets||[]).map(pet=>[pet.id,pet.name])]),
        state?.pet.version&&h('p',null,'已加载版本：'+state.pet.version),
        state?.pet.error&&h('p',{role:'alert'},state.pet.error==='PET_SELECT_REQUIRED'?'请选择要联动的桌宠。':'桌宠展示暂不可用，语音和任务仍可继续。'),
        !state?.pet.available&&h('p',null,'当前宿主未连接桌宠。')))),
      h('div',{className:'va-settings-footer'},h('p',{role:'status'},closePrompt?'还有未保存的更改。':message||(dirty?'有未保存的更改':'设置已同步')),
        closePrompt?h('div',{style:row},h(Button,{disabled:busy,onClick:()=>setClosePrompt(false)},'继续编辑'),h(Button,{disabled:busy,onClick:closeSettings},'放弃更改'),h(Button,{className:'va-primary',disabled:busy,onClick:()=>void saveSettings(true)},'保存并关闭')):h(Button,{className:'va-primary',disabled:busy||!dirty,onClick:()=>void saveSettings()},busy?'处理中…':'保存设置')))
    const setupGaps=assistantSetupGaps(state)
    return h('section',{style:layout,className:'va-panel','aria-label':'语音助手'},h('style',null,assistantPanelStyles),
      preview&&h('div',{className:'va-preview'},h('strong',null,'这是设置预览，不能实际对话'),h('p',null,'这里可以查看设置操作。模型列表是示例，不会连接服务、录音或播放声音。'),state?.capabilities?.assistantUrl&&/^http:\/\/127\.0\.0\.1:\d+\/\?voice-assistant=1$/.test(state.capabilities.assistantUrl)&&h('a',{href:state.capabilities.assistantUrl},'打开 DSH 语音助手 →')),
      h('div',{style:{...row,justifyContent:'space-between'}},h('span',{className:'va-status','data-running':!connectionError&&state?.voice.phase==='running',role:'status'},connectionError?'连接已断开':state?.presentation.statusText||'正在连接'),h(Button,{disabled:!state||connectionError,onClick:openSettings},'设置')),
      connectionError&&h(Button,{disabled:busy,onClick:()=>void refresh().catch(report)},'重新连接'),
      state&&state.voice.phase!=='running'&&setupGaps.length>0&&h('div',{className:'va-setup'},h('strong',null,preview?'了解配置顺序':'先接通文字对话，再开启语音'),h('ol',{className:'va-setup-steps'},[['conversation','对话模型',state.capabilities?.host==='dsh'?'自动读取 DSH 的模型。选择后，先发送一句话确认有回复。':'选择服务并读取模型，保存后发送一句话确认有回复。'],['asr','语音识别','选择识别服务，让助手听懂你说的话。'],['tts','语音播报','选择音色并试听，确认能听到助手声音。'],['devices','设备与开启','测试麦克风后，回到本页点击“开启语音”。']].map(([id,title,description],index)=>h('li',{key:id},h('div',null,h('strong',null,(index+1)+'. '+title),h('p',null,description)),h(Button,{onClick:()=>openSettings(id)},preview?'查看设置':id==='devices'?'检查设备':setupGaps.some(item=>item.section===id)?'去配置':'检查设置'))))),
      h('div',{className:'va-actions'},
        h(Button,{className:'va-primary',disabled:preview||busy||!state||connectionError||state?.voice.phase==='running',onClick:()=>setupGaps.length?openSettings(setupGaps[0].section):invoke({action:'start'})},preview?'预览不支持语音':setupGaps.length?'继续配置':'开启语音'),
        state?.voice.phase==='running'&&h(Button,{disabled:busy,onClick:()=>invoke({action:state.voice.capture==='listening'?'pause':'resume'})},state?.voice.capture==='listening'?'暂停麦克风':'继续收音'),
        h(Button,{disabled:preview||!state||busy||connectionError,onClick:()=>invoke({action:'mute',enabled:!state.voice.outputEnabled})},state?.voice.outputEnabled?'播报静音':'恢复播报'),
        h(Button,{disabled:!state||state?.voice.phase==='stopped',onClick:()=>invoke({action:'stop'})},'停止语音')),
      message&&!editing&&h('p',{role:'status'},message),state?.error&&h('p',{role:'alert'},errors[state.error]||state.error),
      h('div',{'aria-label':'对话',className:'va-conversation'},!messages.length&&h('div',{className:'va-empty'},h('strong',null,preview?'请在实际助手中开始对话':conversationMissing?'先选择一个对话模型':'先试一句文字消息'),h('p',null,preview?'本页只展示设置，发送和语音功能不可用。':conversationMissing?'完成“对话”设置并保存后，就可以在下方输入消息。':'输入“你好”并发送；确认收到回复后，再开启语音。'),state?.capabilities?.host==='standalone'&&h('small',null,'独立助手暂未连接宿主工具。')),messages.map(item=>h('p',{key:item.id,className:'va-message','data-role':item.role,role:item.notice?'alert':undefined},h('strong',null,item.notice?'系统：':item.role==='user'?'我：':'助手：'),item.text))),
      pending&&h('p',{role:'status'},'这条消息的受理结果尚未确认。重试会沿用同一请求编号。'),
      h('div',{className:'va-compose'},h(Input,{value:text,disabled:preview||conversationMissing||Boolean(pending),'aria-label':'消息',placeholder:preview?'预览不能发送消息':conversationMissing?'请先配置对话模型':'输入消息，按 Enter 发送',onChange:event=>setText(event.target.value),onKeyDown:event=>{if(event.key==='Enter'&&!event.nativeEvent?.isComposing){event.preventDefault();void send()}}}),
        h(Button,{className:'va-primary',disabled:preview||conversationMissing||busy||!state||connectionError||!pending&&!text.trim(),onClick:()=>void send()},pending?'核对并重试':'发送')),
      Modal?h(Modal,{open:editing,title:'助手设置',closeLabel:'关闭',onClose:requestClose},settingsBody):editing&&h('div',null,h(Button,{onClick:requestClose},'关闭设置'),settingsBody))
  }
}

/** Provider-owned public capability schema. Controls and request encoding share these keys. */
import {recognitionContextMessages} from './recognition-context.mjs';
import {volcanoDictionary} from './asr-dictionary.mjs';
import { volcanoVoices } from './volcano-voices.mjs';
import expressionFields from './expression-fields.json' with {type:'json'};
import openaiCatalog from './openai-speech-catalog.json' with {type:'json'};
/** Presentation metadata must stay readable before endpoint/credential validation. */
export const recognitionFeedback=config=>config.asrMode==='volcengine'&&config.asrRecognitionMode!=='utterance'?'streaming':'utterance';
const asrDocs='https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh';
const modelDocs='https://docs.volcengine.com/docs/doubao-voice/model-list?lang=zh';
const flag=(key,label,parameter,group,defaultValue=false,note='')=>({key,label,parameter,group,type:'boolean',default:defaultValue,note});
export const volcanoAsrParameters=[
  flag('asrEnableItn','数字与日期规范化','enable_itn','文字处理',true),
  flag('asrEnablePunc','自动标点','enable_punc','文字处理',true),
  flag('asrEnableDdc','去掉语气词和重复内容','enable_ddc','文字处理'),
  {key:'asrResultType',label:'返回结果方式',parameter:'result_type',group:'结果返回',type:'select',default:'full',options:[{id:'full',label:'全量返回'},{id:'single',label:'增量返回'}]},
  flag('asrEnableSpeakerInfo','区分说话人','enable_speaker_info','识别信息'),
  flag('asrEnableLid','语种与方言','enable_lid','识别信息'),
  flag('asrEnableEmotionDetection','情绪检测','enable_emotion_detection','识别信息',false,'返回生气、开心、平静、悲伤或惊讶等模型估计标签。'),
  flag('asrEnableGenderDetection','性别检测','enable_gender_detection','识别信息',false,'返回模型估计标签，不代表身份信息。'),
  flag('asrEnableAgeDetection','年龄检测','enable_age_detection','识别信息',false,'年龄是模型估计值，仅供参考。'),
  flag('asrShowSpeechRate','语速','show_speech_rate','识别信息'),
  flag('asrShowVolume','音量','show_volume','识别信息'),
  flag('asrEnableAccelerateText','首字返回加速','enable_accelerate_text','速度与分句',false,'更快返回首字，可能降低首字准确率。'),
  {key:'asrAccelerateScore',label:'首字加速值',parameter:'accelerate_score',group:'速度与分句',type:'number',default:0,min:0,integer:true,enabledWhen:{key:'asrEnableAccelerateText',equals:true},note:'0 表示不加速，数值越大首字出字越快。'},
  flag('asrEndWindowEnabled','句尾自动提交（静音判停）',null,'速度与分句',true,'关闭后可能只返回临时转写，连续对话建议保持开启。'),
  {key:'asrEndWindowSize',label:'VAD 静音判停（毫秒）',parameter:'end_window_size',group:'速度与分句',type:'number',default:800,min:300,max:5000,integer:true,enabledWhen:{key:'asrEndWindowEnabled',equals:true},note:'推荐 800–1000 毫秒。检测类参数或二遍识别会自动启用 VAD；未指定时服务默认使用 800 毫秒。'},
  {key:'asrVadSegmentDuration',label:'语义分句静音时长（毫秒）',parameter:'vad_segment_duration',group:'速度与分句',type:'number',default:3000,min:0,integer:true,disabledWhenAny:['asrEndWindowEnabled','asrEnableLid','asrEnableEmotionDetection','asrEnableGenderDetection','asrEnableAgeDetection','asrShowSpeechRate','asrShowVolume'],disabledModes:['twopass'],note:'只影响语义分句，不触发判停；使用 VAD 分句时不生效。'},
  {key:'asrForceToSpeechTime',label:'开头保护时长（毫秒）',parameter:'force_to_speech_time',group:'速度与分句',type:'number',default:0,min:0,integer:true,note:'在该时长内避免弱音或静音导致过早判停，0 表示关闭。'},
];
export const volcanoTtsParameters=[
  {key:'ttsVariant',label:'复刻 2.0 合成版本',type:'select',group:'声音与表达',default:'seed-tts-2.0-standard',models:['seed-icl-2.0'],options:[{id:'seed-tts-2.0-standard',label:'标准版 · 延迟优先'},{id:'seed-tts-2.0-expressive',label:'表现力增强版 · 支持语音指令'}]},
  {key:'ttsContextText',label:'语音风格提示词',type:'textarea',group:'声音与表达',default:'',maxLength:2048,models:['seed-tts-2.0','seed-icl-2.0'],requiresExpressive:true,note:'描述希望的情绪、语气、节奏；复刻 2.0 需使用表现力增强版。内容只用于合成指令。'},
  {key:'ttsEmotion',label:'情绪',type:'text',group:'声音与表达',default:'',maxLength:64,note:'仅部分音色支持，按所选音色的情绪标签填写；留空表示不指定。'},
  {key:'ttsEmotionScale',label:'情绪强度',type:'number',group:'声音与表达',default:4,min:1,max:5,enabledWhen:{key:'ttsEmotion',notEmpty:true},note:'强度并非线性增长，具体效果取决于音色。'},
  {key:'ttsSpeechRate',label:'语速',type:'number',group:'声音与表达',default:0,min:-50,max:100,note:'0 为原速；-50 为 0.5 倍，100 为 2 倍。'},
  {key:'ttsLoudnessRate',label:'音量',type:'number',group:'声音与表达',default:0,min:-50,max:100,disabledWhenAny:['ttsMixEnabled'],note:'0 为原音量；混音音色不支持。'},
  {key:'ttsPitch',label:'音调',type:'number',group:'声音与表达',default:0,min:-12,max:12,integer:true},
];
const textParam=(key,label,parameter,group,extra={})=>({key,label,parameter,group,type:'text',default:'',maxLength:2048,...extra});
const numberParam=(key,label,parameter,group,initial,min,max,extra={})=>({key,label,parameter,group,type:'number',default:initial,min,...(max!==undefined?{max}:{}),...extra});
const selectParam=(key,label,parameter,group,initial,options,extra={})=>({key,label,parameter,group,type:'select',default:initial,options:options.map(([id,label])=>({id,label})),...extra});
volcanoAsrParameters.push(
  selectParam('asrOutputZhVariant','中文输出字形','output_zh_variant','文字处理','',[['','默认简体'],['traditional','繁体（大陆）'],['tw','台湾正体'],['hk','香港繁体']]),
  textParam('asrContext','辅助上下文','corpus.context.context_data','词典与上下文',{type:'textarea',note:'只发送此处手动填写的内容，不自动附带其他聊天。'}),
  textParam('asrBoostingTableName','热词表名称','corpus.boosting_table_name','词典与上下文'),
  textParam('asrBoostingTableId','热词表 ID','corpus.boosting_table_id','词典与上下文'),
  textParam('asrCorrectTableName','替换词表名称','corpus.correct_table_name','词典与上下文'),
  textParam('asrCorrectTableId','替换词表 ID','corpus.correct_table_id','词典与上下文'),
  textParam('asrRegexCorrectTableName','正则替换词表名称','corpus.regex_correct_table_name','词典与上下文'),
  textParam('asrRegexCorrectTableId','正则替换词表 ID','corpus.regex_correct_table_id','词典与上下文'),
  flag('asrEnablePoiFc','地名辅助','enable_poi_fc','词典与上下文'),
  flag('asrEnableMusicFc','音乐词辅助','enable_music_fc','词典与上下文'),
  flag('asrSystemReservedFilter','平台敏感词过滤','sensitive_words_filter.system_reserved_filter','文字过滤'),
  textParam('asrFilterWithEmpty','删除的词语（每行一个）','sensitive_words_filter.filter_with_empty','文字过滤',{type:'textarea'}),
  textParam('asrFilterWithSigned','用星号替换的词语（每行一个）','sensitive_words_filter.filter_with_signed','文字过滤',{type:'textarea'}),
);
for(const field of volcanoAsrParameters.filter(f=>['asrEnablePoiFc','asrEnableMusicFc'].includes(f.key)))field.disabledModes=['realtime'];
volcanoTtsParameters.push(
  selectParam('ttsEncoding','音频编码','audio_params.format','音频输出','pcm',[['pcm','PCM · 实时播放'],['mp3','MP3 · 播放适配尚未接入'],['ogg_opus','Opus · 播放适配尚未接入'],['wav','WAV · 流式帧解码尚未接入']]),
  numberParam('ttsBitRate','压缩音频比特率','audio_params.bit_rate','音频输出',64000,16000,160000,{enabledWhen:{key:'ttsEncoding',oneOf:['mp3','ogg_opus']},note:'PCM 的比特率由采样率、位深和声道决定，此项不生效。'}),
  selectParam('ttsSampleRate','采样率','audio_params.sample_rate','音频输出',24000,[8000,16000,22050,24000,32000,44100,48000].map(v=>[v,v+' Hz'])),
  {...flag('ttsTimestamp','返回时间戳（1.0）','audio_params.enable_timestamp','时间戳与字幕'),models:['seed-tts-1.0','seed-icl-1.0'],integration:'timed-captions',note:'仅中英文；播放时由工具自动请求，并按实际播放位置高亮。'},
  {...flag('ttsSubtitle','返回字幕时间戳（2.0）','audio_params.enable_subtitle','时间戳与字幕'),models:['seed-tts-2.0','seed-icl-2.0'],disabledWhenAny:['ttsLatexTn'],integration:'timed-captions',note:'仅中英文；播放时由工具自动请求，字幕可能晚于音频返回，不用估时补字。'},
  numberParam('ttsSilenceDuration','末尾静音（毫秒）','silence_duration','音频输出',0,0,30000),
  flag('ttsLanguageDetector','自动识别合成语种','enable_language_detector','语言与文本'),
  textParam('ttsExplicitLanguage','指定语种','explicit_language','语言与文本',{note:'如 zh-cn、en、ja。按所选音色支持范围填写。'}),
  selectParam('ttsContextLanguage','参考语种','context_language','语言与文本','',[['','默认'],['id','印尼语'],['es','墨西哥西语'],['pt','巴西葡语']]),
  textParam('ttsExplicitDialect','指定方言','explicit_dialect','语言与文本',{note:'按音色目录填写支持的方言，如 dongbei、shaanxi、sichuan；不同音色能力不同。'}),
  flag('ttsMarkdownFilter','过滤 Markdown 标记','disable_markdown_filter','语言与文本'),
  flag('ttsKeepEmoji','保留 Emoji','disable_emoji_filter','语言与文本'),
  {...flag('ttsLatexTn','朗读 LaTeX 公式','enable_latex_tn','语言与文本'),enabledWhen:{key:'ttsMarkdownFilter',equals:true}},
  selectParam('ttsLatexParser','LaTeX 解析器','latex_parser','语言与文本','',[['','默认'],['v2','v2']],{enabledWhen:{key:'ttsMarkdownFilter',equals:true}}),
  selectParam('ttsParenthesisFilter','括号内容','max_length_to_filter_parenthesis','语言与文本',100,[[0,'保留'],[100,'过滤']]),
  numberParam('ttsUnsupportedCharRatio','不支持字符的比例阈值','unsupported_char_ratio_thresh','语言与文本',.3,0,1),
  {...textParam('ttsMuteCutThreshold','静音裁剪阈值','mute_cut_threshold','音频输出',{note:'与保留时长一起设置；留空关闭。参数按平台要求以字符串发送。'}),models:['seed-tts-1.0','seed-icl-1.0']},
  {...textParam('ttsMuteCutRemainMs','静音裁剪后保留时长（毫秒）','mute_cut_remain_ms','音频输出'),models:['seed-tts-1.0','seed-icl-1.0'],enabledWhen:{key:'ttsMuteCutThreshold',notEmpty:true}},
  flag('ttsAigcWatermark','增加音频节奏标识','aigc_watermark','输出标识'),
  flag('ttsUseCache','复用相同文本的音频缓存','cache_config.use_cache','缓存'),
  flag('ttsUseSegmentCache','复用分句缓存','cache_config.use_segment_cache','缓存'),
  {...textParam('ttsSectionId','语音上下文 ID','section_id','上下文与标签',{note:'同一 ID 可关联平台端的多次合成上下文；留空不关联。'}),models:['seed-tts-2.0','seed-icl-2.0']},
  {...flag('ttsUseTagParser','解析语音标签','use_tag_parser','上下文与标签'),models:['seed-icl-2.0'],requiresExpressive:true,note:'仅表现力增强版，标签作用于单句；需在合成文本中提供受支持的标签。'},
  {...flag('ttsMixEnabled','混合多个音色',null,'音色混合'),models:['seed-tts-1.0'],note:'最多 3 个音色，权重之和必须为 1；请使用平台标注支持混音的音色。'},
  {...flag('ttsMetadataEnabled','音频文件元数据标识',null,'输出标识'),enabledWhen:{key:'ttsEncoding',oneOf:['mp3','ogg_opus','wav']},note:'PCM 流没有文件头，不能嵌入文件元数据。'},
  ...['ContentProducer','ProduceId','ContentPropagator','PropagateId'].map((suffix,i)=>textParam('ttsMetadata'+suffix,['合成服务提供者','内容制作编号','内容传播服务提供者','内容传播编号'][i],null,'输出标识',{enabledWhen:{key:'ttsMetadataEnabled',equals:true}})),
);
for(let i=1;i<=3;i++){
  volcanoTtsParameters.push(textParam('ttsMixSpeaker'+i,'混音音色 '+i,null,'音色混合',{models:['seed-tts-1.0'],enabledWhen:{key:'ttsMixEnabled',equals:true}}));
  volcanoTtsParameters.push(numberParam('ttsMixFactor'+i,'混音权重 '+i,null,'音色混合',i===1?1:0,0,1,{models:['seed-tts-1.0'],enabledWhen:{key:'ttsMixEnabled',equals:true}}));
}
volcanoTtsParameters.find(f=>f.key==='ttsEncoding').options.forEach(o=>{o.supported=o.id==='pcm'});
// All persisted values are primitives; providers may add structured controls only with a typed validator/encoder.
volcanoTtsParameters.find(f=>f.key==='ttsUseCache').default=false;
volcanoAsrParameters.push({...flag('asrUseContext','对话上下文',null,'识别能力',true,'建立识别连接时自动附带最近一条助手回复，帮助识别对话中的词语；长连接中的更新在下次连接生效。'),feature:true});
for(const field of volcanoAsrParameters){
 field.owner=['asrContext','asrResultType'].includes(field.key)?'system':'user';field.kind='asr';
 if(field.group==='识别信息'||['asrEnablePoiFc','asrEnableMusicFc'].includes(field.key))field.feature=true;
 if(field.type==='boolean'&&field.key!=='asrSystemReservedFilter')field.default=true;
 const notes={asrEnableSpeakerInfo:'返回分句的说话人编号，帮助区分不同说话人；编号不是身份认证。',asrEnableLid:'返回中文、英文及平台支持方言的语种或场景标签。',asrShowSpeechRate:'返回分句语速，单位为 token/s。',asrShowVolume:'返回分句音量，单位为 dB。',asrEnablePoiFc:'调用平台的地图领域推荐词能力辅助识别地名；在二遍纠正或整句识别模式下使用。',asrEnableMusicFc:'调用平台的音乐领域推荐词能力辅助识别音乐相关词语；在二遍纠正或整句识别模式下使用。'};
 if(notes[field.key])field.note=notes[field.key];
 if(field.key==='asrAccelerateScore')field.default=1;
 if(field.key==='asrContext'){field.integration='dialog-context';field.note='程序自动提供当前对话最近一条助手回复，受平台上下文长度限制；无上下文时不发送。'}
 if(field.key==='asrResultType'){field.integration='asr-loop';field.note='返回全量或增量识别结果，由共享语音循环解析，不需要手动填写。'}
}
for(const field of volcanoTtsParameters){const expression=expressionFields.find(item=>item.setting===field.key);field.owner=expression&&field.key!=='ttsSpeechRate'?'agent':['上下文与标签','时间戳与字幕'].includes(field.group)||field.key.startsWith('ttsMetadata')?'system':'user';if(expression)field.expressionField=expression.id;field.kind='tts'}
const allFields=new Map([...volcanoAsrParameters,...volcanoTtsParameters].map(field=>[field.key,field]));
for(const field of [...openaiCatalog.asr.parameters,...openaiCatalog.tts.parameters])if(!allFields.has(field.key))allFields.set(field.key,field);
export const speechParameterDefinitions=Object.fromEntries([...allFields.values()].map(({key,default:initial,min,max,maxLength,integer,options})=>[key,{default:initial,...(min!==undefined?{min}:{}),...(max!==undefined?{max}:{}),...(maxLength!==undefined?{max:maxLength}:{}),...(integer?{integer}:{}),...(options?{enum:options.filter(o=>o.supported!==false).map(o=>o.id)}:{})}]));
export const speechSelectionDefinitions={
  asrRecognitionMode:{default:'twopass',enum:['realtime','twopass','utterance']},
  asrBilling:{default:'duration',enum:['duration','concurrent']},
  ttsBilling:{default:'characters',enum:['characters','concurrent']},
  ttsDynamicExpression:{default:false},
};
export const volcanoCatalog={
  asr:{
    docs:asrDocs,verifiedAt:'2026-11-16',
    detectionInfo:'识别信息默认开启，可分别关闭。情绪、性别和年龄是模型估计值，结果可在消息详情中查看。',
    billingDocs:'https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh',
    models:[
      {id:'bigmodel',label:'豆包流式语音识别 2.0',supported:true,resources:{duration:'volc.seedasr.sauc.duration',concurrent:'volc.seedasr.sauc.concurrent'}},
      {id:'bigmodel-1.0',label:'豆包流式语音识别 1.0（历史版本）',supported:true,resources:{duration:'volc.bigasr.sauc.duration',concurrent:'volc.bigasr.sauc.concurrent'}},
      {id:'file-standard',label:'录音文件识别 · 标准版',supported:false,note:'需要文件上传和异步查询，当前连续对话入口尚未接入。'},
      {id:'file-turbo',label:'录音文件识别 · 极速版',supported:false,note:'当前连续对话入口尚未接入文件识别。'},
      {id:'file-idle',label:'录音文件识别 · 闲时版',supported:false,note:'异步离线任务，当前连续对话入口尚未接入。'},
    ],
    modes:[
      {id:'realtime',label:'实时识别 · 边说边出字',endpoint:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',note:'持续返回中间结果，最终分句提交给助手。'},
      {id:'twopass',label:'实时识别 + 二遍纠正',endpoint:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',note:'实时返回文字，句末再识别一次提高准确率。'},
      {id:'utterance',label:'一句话识别 · 句末出字',endpoint:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',note:'持续上传音频，在句末返回整句结果。'},
    ],
    billing:[{id:'duration',label:'按时长'},{id:'concurrent',label:'按并发'}],
    parameters:volcanoAsrParameters,
    capabilities:['连续收音','首个有效转写打断播报','最终分句去重','16 kHz 单声道 PCM'],
  },
  tts:{
    docs:'https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-text-to-speech-websocket?lang=zh',verifiedAt:'2026-11-16',
    models:[
      {id:'seed-tts-2.0',label:'豆包语音合成 2.0',supported:true,resources:{characters:'seed-tts-2.0'},note:'使用 2.0 公共音色。'},
      {id:'seed-icl-2.0',label:'豆包声音复刻 2.0',supported:true,resources:{characters:'seed-icl-2.0'},note:'使用已在平台完成复刻的专属音色 ID。'},
      {id:'seed-tts-1.0',label:'豆包语音合成 1.0（历史版本）',supported:true,resources:{characters:'seed-tts-1.0',concurrent:'seed-tts-1.0-concurr'},note:'使用 1.0 公共音色。'},
      {id:'seed-icl-1.0',label:'豆包声音复刻 1.0（历史版本）',supported:true,resources:{characters:'seed-icl-1.0',concurrent:'seed-icl-1.0-concurr'},note:'使用已在平台完成复刻的专属音色 ID。'},
    ],
    modes:[{id:'bidirectional',label:'双向流式 · 文本边生成边播报',supported:true},{id:'unidirectional',label:'单向流式',supported:false,note:'平台支持；本助手尚未接入此协议。'},{id:'http',label:'HTTP 合成',supported:false,note:'平台支持；本助手尚未接入此协议。'}],
    billing:[{id:'characters',label:'按字符'},{id:'concurrent',label:'按并发'}],
    inputCapabilities:['增量文本','已选音色','每轮表达参数'],outputCapabilities:[{label:'流式音频',status:'available'},{label:'逐字跟随字幕（中英文）',status:'available'}],
    capabilities:['增量文本输入','8–48 kHz PCM 流式播放','随时打断','本地播放队列清空'],
    parameters:volcanoTtsParameters,
    voices:volcanoVoices,voiceDocs:'https://www.volcengine.com/docs/6561/1257544',
    voiceNote:'公共音色来自官方目录快照；账户专属复刻音色可填写音色 ID。',
  },
  modelDocs,
};
export function parameterEnabled(field,config){
  return (!field.models||field.models.includes(config[field.kind==='asr'?'asrModel':'ttsModel']))
    &&(!field.requiresExpressive||config.ttsModel!=='seed-icl-2.0'||config.ttsVariant==='seed-tts-2.0-expressive')
    &&(!field.enabledWhen||(field.enabledWhen.oneOf?field.enabledWhen.oneOf.includes(config[field.enabledWhen.key]):field.enabledWhen.notEmpty?Boolean(config[field.enabledWhen.key]):config[field.enabledWhen.key]===field.enabledWhen.equals))
    &&!field.disabledWhenAny?.some(key=>config[key])
    &&!field.disabledModes?.includes(config.asrRecognitionMode);
}
export function encodeVolcanoTtsParams(config){
  const voice=volcanoVoices.find(item=>item.id===config.ttsVoice);
  if(voice&&(voice.model!==config.ttsModel||!voice.bidirectional))throw Error('SPEECH_VOICE_UNSUPPORTED');
  const audio_params={format:'pcm',sample_rate:config.ttsSampleRate??24000,speech_rate:config.ttsSpeechRate??0,loudness_rate:config.ttsLoudnessRate??0};
  if(config.ttsEmotion){
    if(voice&&!voice.emotions.some(item=>item.id===config.ttsEmotion))throw Error('SPEECH_EMOTION_UNSUPPORTED');
    audio_params.emotion=config.ttsEmotion;audio_params.emotion_scale=config.ttsEmotionScale??4
  }
  const additions={post_process:{pitch:config.ttsPitch??0}};
  for(const field of volcanoTtsParameters){
    if(!field.parameter||!parameterEnabled(field,config))continue;
    const value=config[field.key]??field.default;
    if(value==='')continue;
    if(field.parameter.startsWith('audio_params.'))audio_params[field.parameter.slice(13)]=value;
    else if(field.parameter.startsWith('cache_config.')){if(value){additions.cache_config||={text_type:1};additions.cache_config[field.parameter.slice(13)]=value}}
    else additions[field.parameter]=value;
  }
  if(config.ttsContextText&&parameterEnabled(volcanoTtsParameters.find(f=>f.key==='ttsContextText'),config))additions.context_texts=[config.ttsContextText];
  const result={speaker:config.ttsVoice,audio_params,additions:JSON.stringify(additions),...(config.ttsModel==='seed-icl-2.0'?{model:config.ttsVariant||'seed-tts-2.0-standard'}:{})};
  if(config.ttsMixEnabled&&config.ttsModel==='seed-tts-1.0'){
    const speakers=[1,2,3].filter(i=>config['ttsMixSpeaker'+i]).map(i=>({source_speaker:config['ttsMixSpeaker'+i],mix_factor:config['ttsMixFactor'+i]}));
    if(!speakers.length||Math.abs(speakers.reduce((sum,item)=>sum+item.mix_factor,0)-1)>1e-6)throw Error('SPEECH_MIX_WEIGHTS_INVALID');
    result.speaker='custom_mix_bigtts';result.mix_speaker={speakers};
    delete result.audio_params.loudness_rate;
  }
  return result;
}
export function encodeVolcanoAsrRequest(config,options={}){
  const request={model_name:'bigmodel',show_utterances:true,enable_nonstream:config.asrRecognitionMode==='twopass'};
  for(const field of volcanoAsrParameters){
    if(!field.parameter||field.parameter.includes('.')||!parameterEnabled(field,config))continue;
    if(config[field.key]==='')continue;
    request[field.parameter]=config[field.key]??field.default;
  }
  const corpus={};
  for(const field of volcanoAsrParameters.filter(f=>f.parameter?.startsWith('corpus.')&&!f.parameter.startsWith('corpus.context.')))if(config[field.key])corpus[field.parameter.slice(7)]=config[field.key];
  const context={};
  const hotwords=volcanoDictionary(config);
  if(hotwords.length)context.hotwords=hotwords;
  if(Object.hasOwn(options,'context')){const values=recognitionContextMessages(options.context);if(values.length){context.context_type='dialog_ctx';context.context_data=values}}
  else if(config.asrContext){context.context_type='dialog_ctx';context.context_data=[{speaker:'user',text:config.asrContext}]}
  if(Object.keys(context).length)corpus.context=JSON.stringify(context);
  if(Object.keys(corpus).length)request.corpus=corpus;
  if(config.asrSystemReservedFilter||config.asrFilterWithEmpty||config.asrFilterWithSigned)request.sensitive_words_filter=JSON.stringify({system_reserved_filter:Boolean(config.asrSystemReservedFilter),filter_with_empty:(config.asrFilterWithEmpty||'').split(/\r?\n/).filter(Boolean),filter_with_signed:(config.asrFilterWithSigned||'').split(/\r?\n/).filter(Boolean)});
  return request;
}
/** Selecting known models/modes updates protocol fields, never credentials. */
export function applySpeechSelection(previous,next,patch,kind){
  const provider=kind==='asr'?next.asrMode:next.ttsProvider;
  if(provider!=='volcengine')return next;
  const catalog=volcanoCatalog[kind],model=catalog.models.find(item=>item.id===next[kind+'Model']);
  if(!model?.supported)throw Error('SPEECH_MODEL_UNSUPPORTED');
  const billingKey=kind+'Billing',billing=next[billingKey]||(kind==='asr'?'duration':'characters');
  const resource=model.resources[billing];
  if(!resource)throw Error('SPEECH_BILLING_UNSUPPORTED');
  const selectionChanged=Object.hasOwn(patch,kind+'Model')||Object.hasOwn(patch,billingKey);
  if(selectionChanged&&!Object.hasOwn(patch,kind+'ResourceId'))next[kind+'ResourceId']=resource;
  if(kind==='asr'&&(Object.hasOwn(patch,'asrRecognitionMode')||previous.asrRecognitionMode!==next.asrRecognitionMode)&&!Object.hasOwn(patch,'asrEndpoint')){
    const mode=catalog.modes.find(item=>item.id===next.asrRecognitionMode);
    if(!mode)throw Error('SPEECH_MODE_UNSUPPORTED');
    next.asrEndpoint=mode.endpoint;
  }
  return next;
}

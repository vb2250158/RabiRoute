import { createHash } from 'node:crypto';
import { validateProviderEndpoint } from './provider-profiles.mjs';
export const modelProviders = [
  { id:'compatible',label:'OpenAI / 兼容服务',endpoint:'https://api.openai.com/v1/chat/completions' },
  { id:'workbuddy-cn',label:'WorkBuddy 国内版',endpoint:'http://127.0.0.1:18088/v1/chat/completions',hint:'连接已登录国内账号的 WorkBuddy 网关。此处使用网关密钥，不是 CodeBuddy CLI 访问密钥。' },
];
export function validateModelEndpoint(endpoint,provider='compatible') {
  if(!modelProviders.some(item=>item.id===provider))throw Error('ASSISTANT_MODEL_PROVIDER_INVALID');
  let url;try{url=new URL(endpoint)}catch{throw Error('ASSISTANT_MODEL_ENDPOINT_INVALID')}
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&local))throw Error('ASSISTANT_MODEL_ENDPOINT_INVALID');
  if(provider==='workbuddy-cn'&&!local)throw Error('ASSISTANT_WORKBUDDY_LOCAL_GATEWAY_REQUIRED');
  return url.href;
}
export function modelCredentialRef(provider,endpoint) {return 'llm:'+provider+':'+createHash('sha256').update(validateModelEndpoint(endpoint,provider)).digest('hex')}
export function updateModelProfiles(previous,patch) {
  const old=previous.llmProvider||'compatible',next=patch.llmProvider||old;
  const definition=modelProviders.find(item=>item.id===next);if(!definition)throw Error('ASSISTANT_MODEL_PROVIDER_INVALID');
  const profiles={...previous.llmProfiles,[old]:{endpoint:previous.llmEndpoint,model:previous.llmModel}};
  const current={endpoint:definition.endpoint,model:'',...profiles[next],...(patch.llmEndpoint!==undefined?{endpoint:patch.llmEndpoint}:{}),...(patch.llmModel!==undefined?{model:patch.llmModel}:{})};
  validateModelEndpoint(current.endpoint,next);profiles[next]=current;
  return {...previous,...patch,llmProvider:next,llmEndpoint:current.endpoint,llmModel:current.model,llmProfiles:profiles};
}
/** OpenAI-compatible catalog, also used by the existing DSH WorkBuddy gateway. */
export async function listProviderModels({kind,provider,endpoint,resolveCredential,fetcher=fetch}) {
  if(!['llm','asr','tts'].includes(kind))throw Error('MODEL_CATALOG_KIND_INVALID');
  if(provider==='volcengine'||provider==='native')throw Error('MODEL_CATALOG_UNAVAILABLE');
  if (kind !== 'llm' && provider !== 'compatible') throw Error('MODEL_CATALOG_UNAVAILABLE');
  const url=new URL(kind==='llm'?validateModelEndpoint(endpoint,provider):validateProviderEndpoint(endpoint,provider));
  if(url.username||url.password||url.search||url.hash)throw Error('MODEL_CATALOG_ENDPOINT_INVALID');
  const path=url.pathname.replace(/\/(chat\/completions|audio\/(transcriptions|speech))\/?$/,'/models');
  if(path===url.pathname)throw Error('MODEL_CATALOG_UNAVAILABLE');
  url.pathname=path;
  const key=await resolveCredential();
  if(url.hostname==='api.openai.com'&&key?.startsWith('ck_'))throw Error('MODEL_CREDENTIAL_PROVIDER_MISMATCH');
  const result=await fetcher(url,{headers:key?{Authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!result.ok)throw Error('MODEL_CATALOG_HTTP_'+result.status);
  const reader=result.body?.getReader();if(!reader)throw Error('MODEL_CATALOG_EMPTY');
  let size=0;const chunks=[];
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>1024*1024)throw Error('MODEL_CATALOG_LIMIT');chunks.push(item.value)}}finally{await reader.cancel();reader.releaseLock()}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('MODEL_CATALOG_INVALID')}
  if(!Array.isArray(data.data))throw Error('MODEL_CATALOG_INVALID');
  const unique=new Map();
  for(const model of data.data.slice(0,1000))if(typeof model.id==='string'&&model.id.length<=256&&model.id.trim())unique.set(model.id,{id:model.id,label:typeof model.name==='string'?model.name.slice(0,256):model.id});
  return [...unique.values()].sort((a,b)=>a.label.localeCompare(b.label));
}

const prefix='<voice ';
const entities=value=>value.replace(/&quot;/g,'"').replace(/&amp;/g,'&');

/** Capability whitelist shared by all hosts; expression cannot select accounts or voices. */
export function normalizeSpeechExpression(value,policy={}){
 const result={};if(!policy.enabled||!value||typeof value!=='object'||Array.isArray(value))return result;
 for(const field of policy.fields||[]){const item=value[field.id];if(item===undefined)continue;
   if(field.type==='text'&&typeof item==='string'&&item.length<=(field.maxLength||512))result[field.id]=item;
   if(field.type==='enum'&&typeof item==='string'&&field.values.includes(item))result[field.id]=item;
   if(field.type==='number'&&(typeof item==='number'||typeof item==='string'&&item.trim()!=='')&&Number.isFinite(Number(item))&&Number(item)>=field.min&&Number(item)<=field.max)result[field.id]=Number(item);
 }
 return result;
}

export function speechExpressionInstruction(policy={}){
 if(!policy.enabled)return '';
 return '\n语音表达：仅当当前应用消息的 speechCapabilities.enabled=true 时，普通自然语言回答开头先输出一个不朗读的控制头 <voice style="温柔自然"/>，随后直接流式输出正文。控制头与台词在同一轮生成，不要另作情绪解释。根据全局人设、当前情境和台词决定本轮表达；不要把开朗人设机械用于悲伤场景。属性只可使用本次 speechCapabilities.fields 给出的 id、类型、范围和枚举，全部可选。属性值用双引号，值中的双引号写 &quot;，不要在控制头中写花括号。仅输出一个控制头；未启用语音表达时不要输出控制头。工具动作或其他要求的 JSON 仍使用原格式，不加控制头。';
}

/** Incremental control header; ordinary prose streams without waiting for the whole reply. */
export function createSpeechExpressionDecoder(policy={}){
 let buffer='',decided=false,text='',expression={},warning=null,stripLeading=false;
 const append=delta=>{if(stripLeading){delta=delta.replace(/^\s+/,'');if(delta)stripLeading=false}text+=delta;return delta};
 return {
   push(delta){
     if(typeof delta!=='string')throw Error('SPEECH_EXPRESSION_TEXT_INVALID');
     if(decided)return {delta:append(delta),text};
     buffer+=delta;const candidate=buffer.trimStart();
     if(prefix.startsWith(candidate))return {delta:'',text};
     if(!candidate.startsWith(prefix)){decided=true;const value=buffer;buffer='';return {delta:append(value),text}}
     const end=candidate.indexOf('/>');
     if(end<0){if(candidate.length>2048)throw Error('SPEECH_EXPRESSION_HEADER_LIMIT');return {delta:'',text}}
     const attributes=candidate.slice(prefix.length,end),values={};let consumed='';
     const pattern=/([a-z][a-zA-Z]*)\s*=\s*"([^"<>]*)"/g;
     for(const match of attributes.matchAll(pattern)){values[match[1]]=entities(match[2]);consumed+=match[0]}
     const residue=attributes.replace(pattern,'').trim();
     if(residue||!consumed)warning='SPEECH_EXPRESSION_HEADER_INVALID';
     else expression=normalizeSpeechExpression(values,policy);
     decided=true;buffer='';stripLeading=true;
     return {delta:append(candidate.slice(end+2)),text,expression,warning};
   },
   finish(){
     const candidate=buffer.trimStart();
     if(!decided&&(candidate.startsWith(prefix)||candidate.startsWith('<')&&prefix.startsWith(candidate))){warning='SPEECH_EXPRESSION_HEADER_INVALID';buffer=''}
     const delta=decided?'':append(buffer);buffer='';decided=true;return {delta,text,expression,warning};
   },
   getState:()=>({text,expression,warning}),
 };
}

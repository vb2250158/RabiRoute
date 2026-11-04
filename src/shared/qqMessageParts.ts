export type QqMessagePart = {kind:'text';text:string}|{kind:'mention';target:string}|{kind:'reply';id:string}|{kind:'media';mediaKind:string;index:number;name:string}|{kind:'label';text:string};
export const QQ_MESSAGE_LABELS:Record<string,string>={image:'图片',video:'视频',record:'语音',audio:'语音',file:'文件',face:'表情',forward:'合并转发',json:'卡片消息',xml:'卡片消息',poke:'戳一戳',shake:'窗口抖动'};
/** A persisted display projection contains no provider URL, path or executable segment. */
export function storedQqParts(value:unknown):QqMessagePart[]|undefined {
  if(!Array.isArray(value))return;
  return value.flatMap((part):QqMessagePart[]=>{
    if(!part||typeof part!=='object')return [];
    const p=part as Record<string,unknown>;
    if(p.kind==='text'&&typeof p.text==='string')return [{kind:'text',text:p.text}];
    if(p.kind==='mention'&&typeof p.target==='string')return [{kind:'mention',target:p.target}];
    if(p.kind==='reply'&&typeof p.id==='string')return [{kind:'reply',id:p.id}];
    if(p.kind==='label'&&typeof p.text==='string')return [{kind:'label',text:p.text}];
    if(p.kind==='media'&&['image','video','record','audio','file'].includes(String(p.mediaKind))&&Number.isSafeInteger(p.index)&&Number(p.index)>=0)return [{kind:'media',mediaKind:String(p.mediaKind),index:Number(p.index),name:typeof p.name==='string'?p.name:QQ_MESSAGE_LABELS[String(p.mediaKind)]??'附件'}];
    return [];
  });
}
const decode=(value:string)=>value.replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&#44;/g,',').replace(/&amp;/g,'&');
/** Parse CQ structure before decoding entities; never turn escaped text into a command or URL. */
export function qqMessageParts(text:string):QqMessagePart[] {
  const parts:QqMessagePart[]=[];let offset=0,index=0;
  for(const match of text.matchAll(/\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g)) {
    if(match.index!>offset)parts.push({kind:'text',text:decode(text.slice(offset,match.index))});
    const data:Record<string,string>={};
    for(const field of match[2]!.split(',').slice(1)){const at=field.indexOf('=');if(at>=0)data[field.slice(0,at)]=decode(field.slice(at+1));}
    const type=match[1]!;
    if(type==='at')parts.push({kind:'mention',target:data.qq??''});
    else if(type==='reply')parts.push({kind:'reply',id:data.id??''});
    else if(['image','video','record','file'].includes(type))parts.push({kind:'media',mediaKind:type,index:index++,name:data.name||QQ_MESSAGE_LABELS[type]!});
    else parts.push({kind:'label',text:QQ_MESSAGE_LABELS[type]??'其他消息'});
    offset=match.index!+match[0].length;
  }
  if(offset<text.length)parts.push({kind:'text',text:decode(text.slice(offset))});
  return parts;
}

/** Project native OneBot segments; text stays literal and transport URLs never enter display parts. */
export function qqStructuredMessageParts(message:unknown,plainText:string,mediaNames?:string[]):QqMessagePart[] {
  if(typeof message==='string')return qqMessageParts(message).map(part=>part.kind==='media'?{...part,name:mediaNames?.[part.index]??QQ_MESSAGE_LABELS[part.mediaKind]??'附件'}:part);
  if(!Array.isArray(message))return [{kind:'text',text:plainText}];
  let mediaIndex=0;
  return message.map((segment):QqMessagePart=>{
    if(!segment||typeof segment!=='object')return {kind:'label',text:'其他消息'};
    const row=segment as {type?:unknown;data?:unknown},type=String(row.type??'');
    const data=row.data&&typeof row.data==='object'?row.data as Record<string,unknown>:{};
    if(type==='text')return {kind:'text',text:String(data.text??'')};
    if(type==='at')return {kind:'mention',target:String(data.qq??'')};
    if(type==='reply')return {kind:'reply',id:String(data.id??'')};
    if(['image','video','record','file'].includes(type)){const index=mediaIndex++;return {kind:'media',mediaKind:type,index,name:mediaNames?.[index]??QQ_MESSAGE_LABELS[type]!};}
    return {kind:'label',text:QQ_MESSAGE_LABELS[type]??'其他消息'};
  });
}
export function qqPartsPreview(parts:QqMessagePart[]):string {
  return parts.map(part=>part.kind==='text'?part.text:part.kind==='mention'?`@${part.target==='all'?'全体成员':part.target}`:part.kind==='reply'?'[引用]':`[${part.kind==='media'?QQ_MESSAGE_LABELS[part.mediaKind]:part.text}]`).join('');
}

import {qqMessageParts,qqPartsPreview,type QqMessagePart} from '../../src/shared/qqMessageParts';
export {qqMessageParts} from '../../src/shared/qqMessageParts';
export {qqPartsPreview} from '../../src/shared/qqMessageParts';
export type {QqMessagePart} from '../../src/shared/qqMessageParts';
import type { MessageContextRecord } from '../../src/messageContextStore';
import type { QqConversation, HistoryQqRoute } from '../../src/shared/qqConversationHistory';
import type { MessageContextAttachment } from '../../src/messageContextStore';
export type QqSelection = { routeId:string; kind:'group'|'private'; target:string };
export const qqConversationIdentity=(row:QqConversation)=>row.kind==='unknown'?row.conversationKey:JSON.stringify([row.gatewayId,row.instanceId??'',row.kind,row.target]);
/** A missing source is historical evidence, never permission to select the current account. */
export const qqConfiguredRoute=(row:QqConversation,routes:HistoryQqRoute[])=>routes.find(route=>Boolean(row.gatewayId)&&route.routeId===row.gatewayId&&(route.instanceId??'')===(row.instanceId??''));
export function mergeQqConversations(preferred:QqConversation[],additional:QqConversation[]):QqConversation[] {
  const rows:QqConversation[]=[],indices=new Map<string,number>();
  for(const row of [...preferred,...additional]) {
    const identity=qqConversationIdentity(row),index=indices.get(identity);
    if(index===undefined){indices.set(identity,rows.length);rows.push(row);continue;}
    const first=rows[index]!;
    const stored=first.conversationKey.startsWith('qq-live:')?(row.storedConversationKey||(!row.conversationKey.startsWith('qq-live:')?row.conversationKey:undefined)):undefined;
    if(stored||row.time>first.time)rows[index]={...first,...(stored?{storedConversationKey:stored}:{}),...(row.time>first.time?{time:row.time,preview:row.preview,previewFormat:row.previewFormat}:{})};
  }
  return rows;
}
export type QqHistoryMessage={messageId:string;time?:number;sender:string;senderName?:string;text:string;attachments?:{kind:string;name:string}[];parts?:QqMessagePart[]};
export type QqHistoryRecord=MessageContextRecord&{qqSenderName?:string;qqParts?:QqMessagePart[]};
export function mergeQqHistoryWindow(current:QqHistoryRecord[],page:QqHistoryRecord[],atBottom:boolean):{entries:QqHistoryRecord[];newerAvailable:boolean} {
  const known=new Set(current.map(row=>row.id));
  if(current.length&&page.length&&!page.some(row=>known.has(row.id)))return {entries:current,newerAvailable:true};
  const merged=[...new Map([...current,...page].map(row=>[row.id,row])).values()].sort((a,b)=>a.time-b.time);
  const entries=atBottom?merged.slice(-200):merged.slice(0,200);
  return {entries,newerAvailable:!atBottom&&(entries.length<merged.length||page.some(row=>!known.has(row.id)))};
}
/** Historical ledgers once classified text/@/reply segments as attachments. */
export function qqDisplayParts(text:string,structured:QqMessagePart[]|undefined,attachments:MessageContextAttachment[]=[]):QqMessagePart[] {
  if(structured!==undefined)return structured.slice();
  const parts=qqMessageParts(text);
  if(parts.some(part=>part.kind==='media'))return parts;
  const kinds=new Set(['image','video','record','audio','file']);
  for(const attachment of attachments) {
    if(attachment.kind&&!kinds.has(attachment.kind))continue;
    if(!attachment.kind&&!attachment.name&&!attachment.mimeType)continue;
    const index=parts.filter(part=>part.kind==='media').length;
    parts.push({kind:'media',index,mediaKind:attachment.kind==='audio'?'record':attachment.kind??'file',name:attachment.name||({image:'图片',video:'视频',record:'语音',audio:'语音',file:'文件'}[attachment.kind??'file']??'文件')});
  }
  return parts;
}
export function qqHistoryRecord(row:QqHistoryMessage,selection:QqSelection,ownId?:string):QqHistoryRecord {
  return {id:JSON.stringify([selection.routeId,selection.kind,selection.target,row.messageId]),adapter:'napcat',gatewayId:selection.routeId,
    conversationKey:`qq-live:${JSON.stringify([selection.routeId,selection.kind,selection.target])}`,kind:selection.kind,target:selection.target,
    time:row.time??0,messageId:row.messageId,sender:row.sender,qqSenderId:row.sender,qqSenderName:row.senderName,qqParts:row.parts,
    direction:ownId&&row.sender===ownId?'outbound':'inbound',text:row.text,attachments:row.attachments};
}
/** QQ's documented avatar endpoints take numeric IDs, never arbitrary record URLs. */
export function qqAvatarUrl(kind:'group'|'private',id:string|undefined):string|undefined {
  if(!id||!(/^[1-9]\d{0,15}$/).test(id))return;
  return kind==='group'?`https://p.qlogo.cn/gh/${id}/${id}/100`:`https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk=${id}`;
}
export function qqMessagePreview(text:string):string {
  return qqPartsPreview(qqMessageParts(text));
}
export function qqMessageUrl(selection:QqSelection,messageId:string|number):string|undefined {
  const id=String(messageId);
  if(!/^-?\d{1,20}$/.test(id))return;
  return `/api/agent/qq/messages/${encodeURIComponent(id)}?${new URLSearchParams(selection)}`;
}
/** Only known passive browser media is previewed; unknown bytes stay downloadable files. */
export function qqMediaMime(bytes:Uint8Array):string {
  const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.slice(start,end));
  if(bytes[0]===0x89&&ascii(1,4)==='PNG')return 'image/png';
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(ascii(0,6)==='GIF87a'||ascii(0,6)==='GIF89a')return 'image/gif';
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return 'image/webp';
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')return 'audio/wav';
  if(ascii(0,4)==='OggS')return 'audio/ogg';
  if(ascii(0,3)==='ID3'||(bytes[0]===0xff&&(bytes[1]!&0xe0)===0xe0))return 'audio/mpeg';
  if(ascii(4,8)==='ftyp')return 'video/mp4';
  if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3)return 'video/webm';
  return 'application/octet-stream';
}

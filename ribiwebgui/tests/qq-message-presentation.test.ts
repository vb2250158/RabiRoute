import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeQqConversations,qqHistoryRecord,qqAvatarUrl,qqMessageParts,qqMessagePreview,qqMessageUrl,qqMediaMime} from '../src/qqMessagePresentation';
import {qqStructuredMessageParts} from '../../src/shared/qqMessageParts';

test('native segments preserve literal CQ text, mentions and quotes without transport URLs',()=>{
  const parts=qqStructuredMessageParts([{type:'text',data:{text:'[CQ:image,file=literal]'}},{type:'at',data:{qq:'42'}},{type:'reply',data:{id:'-7'}},{type:'image',data:{file:'private-path',url:'https://private.invalid/token'}}],'');
  assert.deepEqual(parts,[{kind:'text',text:'[CQ:image,file=literal]'},{kind:'mention',target:'42'},{kind:'reply',id:'-7'},{kind:'media',mediaKind:'image',index:0,name:'图片'}]);
  assert.equal(JSON.stringify(parts).includes('private'),false);
  assert.deepEqual(qqStructuredMessageParts(undefined,'[CQ:image,file=literal]'),[{kind:'text',text:'[CQ:image,file=literal]'}]);
});

test('live QQ directory fills missing conversations without duplicating saved identities or mixing accounts',()=>{
  const saved={conversationKey:'saved',gatewayId:'route',instanceId:'one',kind:'group' as const,target:'123',time:10,preview:'saved message'};
  const live={...saved,conversationKey:'qq-live:one',time:0,preview:''};
  const rows=mergeQqConversations([saved],[live,{...live,kind:'private'},{...live,instanceId:'two'}]);
  assert.equal(rows.length,3);assert.equal(rows[0],saved);
  const merged=mergeQqConversations([live],[saved])[0]!;
  assert.equal(merged.conversationKey,live.conversationKey);assert.equal(merged.storedConversationKey,'saved');
  assert.equal(merged.time,10);assert.equal(merged.preview,'saved message');
  const updated=mergeQqConversations([saved],[{...live,time:20,preview:'new QQ message'}])[0]!;
  assert.equal(updated.conversationKey,'saved');assert.equal(updated.time,20);assert.equal(updated.preview,'new QQ message');
  assert.equal(mergeQqConversations([], [live]).length,1);
});
test('QQ native history keeps numeric sender identity, self direction, exact target and media without fabricated time',()=>{
  const selection={routeId:'route',kind:'group' as const,target:'123'};
  const input={messageId:'-7',sender:'42',senderName:'Name',time:100,text:'hello',attachments:[{kind:'image',name:'image'}]};
  const row=qqHistoryRecord(input,selection,'42');
  assert.equal(row.direction,'outbound');assert.equal(row.sender,'42');assert.equal(row.qqSenderName,'Name');
  assert.equal(row.target,'123');assert.equal(row.messageId,'-7');assert.deepEqual(row.attachments,input.attachments);
  assert.equal(qqHistoryRecord(input,selection).direction,'inbound');
  assert.notEqual(row.id,qqHistoryRecord(input,{...selection,routeId:'other'},'42').id);
  assert.equal(qqHistoryRecord({...input,time:undefined},selection).time,0);
});

test('QQ avatars use the intended group/user endpoints and reject nonnumeric identities',()=>{
  assert.equal(qqAvatarUrl('group','10001'),'https://p.qlogo.cn/gh/10001/10001/100');
  assert.equal(qqAvatarUrl('private','20002'),'https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk=20002');
  for(const id of [undefined,'','nickname','123/other','https://example.com'])assert.equal(qqAvatarUrl('private',id),undefined);
});

test('QQ display preserves text order, decodes once, and hides CQ media URLs and local paths',()=>{
  const parts=qqMessageParts('Hi [CQ:at,qq=42][CQ:reply,id=-7][CQ:image,file=C:\\private.png,url=http://untrusted.invalid/secret][CQ:file,name=report&#44;a.txt,file=id] end &amp;&#91;');
  assert.deepEqual(parts,[{kind:'text',text:'Hi '},{kind:'mention',target:'42'},{kind:'reply',id:'-7'},{kind:'media',mediaKind:'image',index:0,name:'图片'},{kind:'media',mediaKind:'file',index:1,name:'report,a.txt'},{kind:'text',text:' end &['}]);
  assert.equal(qqMessagePreview('[CQ:at,qq=all][CQ:face,id=1][CQ:image,file=secret]'),'@全体成员[表情][图片]');
  assert.deepEqual(qqMessageParts('&#91;CQ:image,file=x&#93;'),[{kind:'text',text:'[CQ:image,file=x]'}]);
  assert.equal(qqMessageParts('[CQ:unknown,url=secret]')[0]?.kind,'label');
});
test('media lookup retains the selected Route and exact conversation without caller URLs',()=>{
  assert.equal(qqMessageUrl({routeId:'route & 1',kind:'private',target:'123'},'-45'),'/api/agent/qq/messages/-45?routeId=route+%26+1&kind=private&target=123');
  assert.equal(qqMessageUrl({routeId:'route',kind:'group',target:'123'},'../other'),undefined);
});
test('only passive known media headers are previewed; active document bytes stay files',()=>{
  const bytes=(text:string)=>new TextEncoder().encode(text);
  assert.equal(qqMediaMime(new Uint8Array([137,80,78,71,13,10,26,10])),'image/png');
  assert.equal(qqMediaMime(bytes('GIF89a')),'image/gif');
  assert.equal(qqMediaMime(bytes('RIFF0000WEBP')),'image/webp');
  assert.equal(qqMediaMime(bytes('<svg onload="alert(1)">')),'application/octet-stream');
  assert.equal(qqMediaMime(bytes('<html>')),'application/octet-stream');
  assert.equal(qqMediaMime(new Uint8Array()),'application/octet-stream');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {messageContextFromHistoryRecord,appendMessageContextToDir,recentMessageContextItems} from './messageContextStore.js';
import {storedQqParts} from './shared/qqMessageParts.js';
import {projectPublicQqMessage} from './manager/qqReadContract.js';

const base={time:1760000000,groupId:10001,userId:20002,senderName:'30003',messageId:'-7',rawMessage:'晚一点',gatewayId:'route',instanceId:'one'};
test('QQ text, mentions and replies never become files; media indices stay continuous',()=>{
  const row=messageContextFromHistoryRecord('group',{...base,segments:[{type:'at',data:{qq:'42'}},{type:'text',data:{text:'晚一点'}},{type:'reply',data:{id:'-6'}},{type:'image',data:{file:'C:/private.png'}},{type:'file',data:{file_id:'file-id',name:'../report.pdf'}}]})!;
  assert.deepEqual(row.attachments?.map(a=>a.kind),['image','file']);
  assert.equal(row.attachments?.[0]?.id,undefined);
  assert.equal(row.attachments?.[1]?.name,'report.pdf');
  assert.deepEqual(row.qqParts?.filter(p=>p.kind==='media').map(p=>p.index),[0,1]);
  assert.equal(row.sender,'30003');assert.equal(row.qqSenderId,'20002');
  const text=messageContextFromHistoryRecord('group',{...base,segments:[{type:'text',data:{text:'晚一点'}}]})!;
  assert.equal(text.attachments,undefined);assert.deepEqual(text.qqParts,[{kind:'text',text:'晚一点'}]);
});
test('QQ self private identity is the bot, and literal CQ text remains literal through JSONL',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-history-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const row=messageContextFromHistoryRecord('private',{...base,isSelf:true,botUserId:'90009',botNickname:'Bot',segments:[{type:'text',data:{text:'[CQ:image,file=literal]'}}]})!;
  assert.equal(row.qqSenderId,'90009');assert.equal(row.target,'20002');assert.equal(row.sender,'Bot');
  appendMessageContextToDir(directory,row,{archiveCheck:false});
  const restored=recentMessageContextItems([directory],10)[0]!;
  assert.equal(restored.id,row.id);assert.equal(restored.qqSenderId,'90009');
  assert.deepEqual(restored.qqParts,[{kind:'text',text:'[CQ:image,file=literal]'}]);
});
test('legacy QQ metadata is filtered while untyped real files and non-QQ adapters stay valid',()=>{
  const attachments=[{kind:'text'},{kind:'at'},{kind:'reply'},{name:'old.pdf'},{kind:'audio',name:'voice.silk'}];
  const qq=messageContextFromHistoryRecord('group',{...base,attachments})!;
  assert.deepEqual(qq.attachments?.map(a=>a.name),['old.pdf','voice.silk']);
  for(const kind of ['wecom','feishu'] as const){
    const other=messageContextFromHistoryRecord(kind,{...base,conversationId:'chat',chatId:'chat',attachments:[{kind:'document',name:'report.pdf'}]})!;
    assert.equal(other.attachments?.[0]?.kind,'document');assert.equal(other.attachments?.[0]?.name,'report.pdf');
  }
});
test('stored QQ display parts omit transport fields and isolate a damaged part',()=>{
  assert.deepEqual(storedQqParts([{kind:'text',text:'valid',url:'private'},null,{kind:'media',mediaKind:'image',index:0,name:'image.png',file:'private-path'}, {kind:'reply',id:'0'}]),[{kind:'text',text:'valid'},{kind:'media',mediaKind:'image',index:0,name:'image.png'},{kind:'reply',id:'0'}]);
});
test('empty native segment arrays fall back to the original body and explicit real attachments',()=>{
  for(const kind of ['group','private'] as const){
    const text=messageContextFromHistoryRecord(kind,{...base,segments:[]})!;
    assert.deepEqual(text.qqParts,[{kind:'text',text:'晚一点'}]);
    const file=messageContextFromHistoryRecord(kind,{...base,segments:[],attachments:[{kind:'file',name:'real.pdf'}]})!;
    assert.equal(file.qqParts?.at(-1)?.kind,'media');
  }
});
test('native raw_message-only messages project their media and references without losing literal arrays',()=>{
  const selection={routeId:'route',kind:'group' as const,target:'10001'};
  const image=projectPublicQqMessage({message_id:1,message_type:'group',group_id:10001,message:undefined,raw_message:'[CQ:reply,id=-6][CQ:image,file=resource]'},selection);
  assert.deepEqual((image.parts as {kind:string}[]).map(p=>p.kind),['reply','media']);
  assert.equal((image.attachments as unknown[]).length,1);
  const literal=projectPublicQqMessage({message_id:2,message_type:'group',group_id:10001,message:[{type:'text',data:{text:'[CQ:image,file=literal]'}}]},selection);
  assert.deepEqual(literal.parts,[{kind:'text',text:'[CQ:image,file=literal]'}]);
});

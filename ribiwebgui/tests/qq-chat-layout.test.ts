import assert from 'node:assert/strict';
import test from 'node:test';
import { qqConversationTime, qqMessageTime, qqTimeBreak } from '../src/qqChatLayout';

const seconds = (date: Date) => date.getTime()/1000;
test('conversation recency distinguishes today, yesterday, month and year boundaries',()=>{
  const now=new Date(2026,0,1,12);
  assert.equal(qqConversationTime(seconds(new Date(2026,0,1,9,5)),now),'09:05');
  assert.equal(qqConversationTime(seconds(new Date(2025,11,31,23,59)),now),'昨天');
  assert.match(qqConversationTime(seconds(new Date(2025,11,30)),now),/2025/);
  assert.doesNotMatch(qqConversationTime(seconds(new Date(2026,0,2)),now),/2026/);
  assert.equal(qqConversationTime(0,now),'');
  assert.equal(qqConversationTime(seconds(new Date(2025,11,31)),now,'en'),'yesterday');
});
test('message time separators retain midnight boundaries and group nearby messages',()=>{
  const before=seconds(new Date(2026,0,1,23,59)),after=seconds(new Date(2026,0,2,0,1));
  assert.equal(qqTimeBreak(after,before),true);
  assert.equal(qqTimeBreak(before),true);
  const noon=seconds(new Date(2026,0,2,12));
  assert.equal(qqTimeBreak(noon+299,noon),false);
  assert.equal(qqTimeBreak(noon+300,noon),true);
  assert.equal(qqMessageTime(before,new Date(2026,0,2,12)),'昨天 23:59');
});

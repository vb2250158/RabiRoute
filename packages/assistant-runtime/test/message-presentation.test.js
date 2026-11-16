import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantParticipants,messageTimeLabel,createMessageAvatar} from '../ui/message-presentation.js';

test('participant presentation follows the selected host persona without borrowing another avatar',()=>{
  const hostSettings={personaId:'a',personaLabel:'测试助手',personas:[
    {id:'a',avatarConfigured:true,avatarUrl:'/api/roles/a/avatar?v=one'},
    {id:'b',avatarConfigured:false,avatarUrl:'/api/roles/b/avatar'},
  ]};
  assert.equal(assistantParticipants({hostSettings}).assistant.avatarUrl,'/api/roles/a/avatar?v=one');
  assert.equal(assistantParticipants({hostSettings}).assistant.name,'测试助手');
  hostSettings.personaId='b';
  assert.equal(assistantParticipants({hostSettings}).assistant.avatarUrl,'');
  assert.deepEqual(assistantParticipants(null).user,{name:'我',avatarUrl:''});
  for(const host of ['standalone','dsh'])assert.equal(assistantParticipants({capabilities:{host},settings:{assistantName:'工作助手'}}).assistant.name,'工作助手');
  const participants=assistantParticipants({participants:{user:{name:'测试用户',avatarUrl:'/profile/user.png'},assistant:{name:'宿主助手',avatarUrl:'/profile/assistant.png'}},hostSettings});
  assert.equal(participants.user.name,'测试用户');assert.equal(participants.assistant.name,'宿主助手');
});

test('time separators use real timestamps and collapse nearby turns',()=>{
  const first={createdAt:'2026-10-01T01:00:00Z'};
  assert.ok(messageTimeLabel(first));
  assert.equal(messageTimeLabel({createdAt:'2026-10-01T01:04:00Z'},first),'');
  assert.ok(messageTimeLabel({createdAt:'2026-10-01T01:06:00Z'},first));
  assert.equal(messageTimeLabel({}),'');assert.equal(messageTimeLabel({createdAt:'invalid'}),'');
});

test('avatar failures retain a fallback and a new URL can recover through the host resolver',()=>{
  let failed=null;
  const react={createElement:(tag,props,...children)=>({tag,props,children}),useState:()=>[failed,value=>{failed=value;}]};
  const Avatar=createMessageAvatar(react),props={name:'测试助手',kind:'assistant',avatarUrl:'/avatar.png',resolveUrl:value=>'/gateway'+value};
  const image=Avatar(props).children[0];assert.equal(image.tag,'img');assert.equal(image.props.src,'/gateway/avatar.png');
  assert.equal(image.props.referrerPolicy,'no-referrer');image.props.onError();
  assert.equal(Avatar(props).children[0].tag,'span');
  assert.equal(Avatar({...props,avatarUrl:'/avatar-new.png'}).children[0].tag,'img');
  for(const avatarUrl of ['javascript:alert(1)','file:///private/image.png','//untrusted.test/avatar'])assert.notEqual(Avatar({...props,avatarUrl}).children[0].tag,'img');
});

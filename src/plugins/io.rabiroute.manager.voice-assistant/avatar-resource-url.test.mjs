import test from 'node:test';
import assert from 'node:assert/strict';
import {managerAvatarUrl} from './web/avatar-resource-url.mjs';

const page='https://pc.example.test/#/voice-assistant';
const avatar='/api/roles/test/avatar?v=two';
// Model the existing Manager resolver, which adds its prefix only to relative API paths.
const resolver=(prefix='')=>value=>{
  const url=new URL(value.startsWith('/api/')?prefix+value:value,page);
  url.searchParams.set('webgui_token','test-session-token');
  return url.href;
};

test('relative and absolute same-origin API avatars retain authentication and query parameters',()=>{
  for(const value of [avatar,new URL(avatar,page).href]){
    const result=new URL(managerAvatarUrl(value,resolver(),page));
    assert.equal(result.origin,'https://pc.example.test');
    assert.equal(result.pathname,'/api/roles/test/avatar');
    assert.equal(result.searchParams.get('v'),'two');
    assert.equal(result.searchParams.get('webgui_token'),'test-session-token');
  }
});

test('configured Manager proxy paths keep authentication without adding the prefix twice',()=>{
  for(const prefix of ['/manager/proxy','https://remote.example.test/manager/proxy']){
    const resolve=resolver(prefix),expected=resolve(avatar);
    for(const value of [avatar,new URL(avatar,page).href,expected]){
      assert.equal(managerAvatarUrl(value,resolve,page),expected);
    }
    const outside=new URL(prefix+'/api-other/avatar',page).href;
    assert.equal(managerAvatarUrl(outside,resolve,page),outside);
  }
});

test('external and non-Manager avatars never receive the Manager token',()=>{
  for(const prefix of ['', '/manager/proxy','https://remote.example.test/manager/proxy']){
    for(const value of [
      'https://images.example.test/api/roles/test/avatar?v=two',
      'https://pc.example.test.evil.test/api/roles/test/avatar',
      'https://pc.example.test@images.example.test/api/avatar',
      '/public/avatar.png',
      'https://remote.example.test/unrelated/avatar.png',
      'data:image/png;base64,AA==',
      'https://[invalid',
    ]){
      assert.equal(managerAvatarUrl(value,resolver(prefix),page),value);
    }
  }
});

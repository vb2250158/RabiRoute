import test from 'node:test';import assert from 'node:assert/strict';
test('independent plugin module activations can unwrap the same DPAPI secret without global FFI type conflicts',{skip:process.platform!=='win32'||process.arch!=='x64'},async()=>{
 const first=await import('../src/windows-secrets.mjs?activation=first');const value=first.transformWindowsSecret('isolated-reactivation-fixture');
 const second=await import('../src/windows-secrets.mjs?activation=second');assert.equal(second.transformWindowsSecret(value,true),'isolated-reactivation-fixture');
 const third=await import('../src/windows-secrets.mjs?activation=third');assert.equal(first.transformWindowsSecret(third.transformWindowsSecret('next'),true),'next');
});

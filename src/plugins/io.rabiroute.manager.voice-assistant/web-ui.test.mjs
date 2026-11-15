import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import {build} from 'esbuild';
test('real React first frame and host settings render without requiring loaded state or a local persona voice',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rabi-assistant-ui-')),output=join(directory,'ui.mjs');
 try{await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {Panel,HostSettings,SettingsPage} from ${JSON.stringify(fileURLToPath(new URL('./web/assistant-app.jsx',import.meta.url)))};export const renderClosed=()=>renderToStaticMarkup(React.createElement(SettingsPage,{open:false},'CLOSEDSETTINGS'));export const renderHost=props=>renderToStaticMarkup(React.createElement(HostSettings,props));export const renderInitial=()=>renderToStaticMarkup(React.createElement(Panel,{adapter:{read:async()=>null,command:async()=>{},subscribeConversation:()=>()=>{}}}));`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'esm',outfile:output,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
  const ui=await import(pathToFileURL(output));assert.equal(ui.renderClosed(),'');assert.equal(ui.renderHost({state:null}),'');assert.equal(ui.renderHost({state:{}}),'');assert.match(ui.renderInitial(),/正在连接/);
  const base={hostSettings:{personaId:'B',personas:[{id:'B',label:'无本机声线人格'}],asrSource:'host',ttsSource:'custom',models:[],voiceReady:false},context:{busy:false}};
  assert.match(ui.renderHost({state:base,settingsTab:'conversation'}),/无本机声线人格/);
  assert.match(ui.renderHost({state:base,settingsTab:'speech',speechKind:'asr'}),/请选择可用模型/);
  assert.match(ui.renderHost({state:base,settingsTab:'speech',speechKind:'tts'}),/自定义提供商/);
 }finally{await rm(directory,{recursive:true,force:true})}
});

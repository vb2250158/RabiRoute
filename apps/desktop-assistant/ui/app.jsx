import React from 'react';
import { createRoot } from 'react-dom/client';
import { createAssistantPanel } from '@rabilink/assistant-runtime/ui';
import './app.css';

import {createBrowserAccess} from './browser-access.mjs';
let accessRequired=()=>{};
const access=createBrowserAccess({origin:location.origin,hash:location.hash,storage:localStorage,session:sessionStorage,
  clearHash:()=>history.replaceState(null,'','/'),onRequired:()=>accessRequired()});
const request=(path,body)=>access.request(path,body);
const adapter = {
  read: () => request('state'), command: body => request('command', body),
  subscribeConversation(_id, listener, onError) {
    let closed = false, timer;
    const poll = async () => { try { const value = await request('messages'); if (!closed) listener(value); } catch (error) { if (!closed) onError(error); } finally { if (!closed) timer = setTimeout(poll, 350); } };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  },
};
function ScreenModeButton(){
  const [expanded,setExpanded]=React.useState(Boolean(document.fullscreenElement)),[error,setError]=React.useState('');
  React.useEffect(()=>{const update=()=>setExpanded(Boolean(document.fullscreenElement));document.addEventListener('fullscreenchange',update);return()=>document.removeEventListener('fullscreenchange',update)},[]);
  const toggle=async()=>{setError('');try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{setError('浏览器未允许全屏，请最大化窗口。')}};
  return <><button onClick={toggle}>{expanded?'退出全屏':'全屏显示'}</button>{error&&<span role="status">{error}</span>}</>;
}
function SettingsPage({children,open,onClose,title}) {
  if(!open)return null;
  return <section className="assistant-settings-page" aria-label="助手设置">
    <div className="settings-heading"><h2 id="settings-title">{title}</h2><div className="app-window-actions"><ScreenModeButton/><button aria-label="关闭设置" onClick={onClose}>返回对话</button></div></div>
    <div className="settings-content">{children}</div>
  </section>;
}
const wakeStatus = {
  disabled: '手动开始实时语音',
  starting: '正在连接本机麦克风',
  armed: '正在等待唤醒词',
  active: '实时语音进行中',
  'local-fallback': '实时识别暂不可用，正在本机转写',
  waiting: '本机唤醒连接已断开，正在重试',
  unavailable: '本机唤醒不可用，请检查常驻语音服务',
};
function KeywordWakeSettings({state,settingsTab,command,dirty}) {
  const current = state?.settings;
  const [enabled,setEnabled] = React.useState(false);
  const [aliases,setAliases] = React.useState('');
  React.useEffect(()=>{
    const {keywordWakeEnabled,keywordWakeAliases}=current || {};
    setEnabled(Boolean(keywordWakeEnabled));
    setAliases(keywordWakeAliases || '');
  },[current?.keywordWakeEnabled,current?.keywordWakeAliases]);
  if (settingsTab!=='devices'||!state?.keywordWake) return null;
  const changed = enabled!==current.keywordWakeEnabled || aliases!==current.keywordWakeAliases;
  return <fieldset>
    <legend>实时语音启动方式</legend>
    <label>启动模式<select value={enabled?'keyword':'manual'} onChange={event=>setEnabled(event.target.value==='keyword')}>
      <option value="manual">手动开始</option><option value="keyword">手动或关键词唤醒</option>
    </select></label>
    {enabled&&<label>唤醒词<textarea rows={3} value={aliases} onChange={event=>setAliases(event.target.value)} placeholder="每行一个词，例如 星河" maxLength={4096}/></label>}
    <p role="status">{current.voiceEnabled===false?'语音助手已关闭':wakeStatus[state.keywordWake.phase]}</p>
    <button type="button" disabled={dirty||!changed||(enabled&&!aliases.trim())} onClick={()=>command({action:'settings',patch:{keywordWakeEnabled:enabled,keywordWakeAliases:aliases}},'启动模式已保存。')}>保存启动模式</button>
  </fieldset>;
}
const Panel = createAssistantPanel(React, { Modal:SettingsPage,HostSettings:KeywordWakeSettings,settingsPresentation:'page' });
function App() {
  const [authenticationRequired,setAuthenticationRequired]=React.useState(!access.hasToken());
  const [entryLink,setEntryLink]=React.useState(''),[connecting,setConnecting]=React.useState(false),[accessError,setAccessError]=React.useState('');
  React.useEffect(()=>{accessRequired=()=>setAuthenticationRequired(true);return()=>{accessRequired=()=>{}}},[]);
  const reconnect=async event=>{event.preventDefault();setConnecting(true);setAccessError('');try{access.acceptLink(entryLink);await request('state');setEntryLink('');setAuthenticationRequired(false)}catch(error){setAccessError(error.message==='ASSISTANT_LINK_INVALID'?'请粘贴这台助手的完整启动链接。':error.message==='ASSISTANT_AUTH_REQUIRED'?'这个启动链接已失效，请使用最新的本机启动链接。':'暂时无法连接，请确认助手正在运行后重试。')}finally{setConnecting(false)}};
  const [exited, setExited] = React.useState(false), [error, setError] = React.useState('');
  const exit = async () => { try { await adapter.command({ action: 'exit' }); setExited(true); } catch (error) { setError(error.message); } };
  return <><header><div><h1>语音助手</h1><p>语音对话与图表</p></div><div className="app-window-actions"><ScreenModeButton/><button onClick={exit} disabled={exited||authenticationRequired}>退出助手</button></div></header>{error && <p role="alert">{error}</p>}{exited ? <main>助手已退出，音频资源已释放。</main> : authenticationRequired ? <main className="access-required"><h2>重新连接语音助手</h2><p>使用本机启动链接连接一次，之后这个浏览器会记住连接。</p><form onSubmit={reconnect}><label htmlFor="assistant-entry">本机启动链接</label><input id="assistant-entry" type="password" autoComplete="off" value={entryLink} onChange={event=>setEntryLink(event.target.value)} placeholder="粘贴完整启动链接" required /><button type="submit" disabled={connecting||!entryLink.trim()}>{connecting?'正在连接…':'连接助手'}</button></form><p className="access-help">使用助手启动时提供的完整链接，直接输入端口地址不能完成首次连接。</p>{accessError&&<p role="alert">{accessError}</p>}</main> : <Panel adapter={adapter} />}<footer>关闭这个页面不会停止助手。停止收听请使用“结束语音”，结束后台进程请使用“退出助手”。</footer></>;
}
createRoot(document.getElementById('root')).render(<App />);

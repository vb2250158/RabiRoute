import React from 'react';
import { createRoot } from 'react-dom/client';
import { createAssistantPanel } from '@rabilink/assistant-runtime/ui';
import './app.css';

const token = location.hash.slice(1) || sessionStorage.getItem('assistant-token');
if (location.hash) { sessionStorage.setItem('assistant-token', token); history.replaceState(null, '', '/'); }
async function request(path, body) {
  const result = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await result.json(); if (!result.ok) throw Error(value.error); return value;
}
const adapter = {
  read: () => request('state'), command: body => request('command', body),
  subscribeConversation(_id, listener, onError) {
    let closed = false, timer;
    const poll = async () => { try { const value = await request('messages'); if (!closed) listener(value); } catch (error) { if (!closed) onError(error); } finally { if (!closed) timer = setTimeout(poll, 350); } };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  },
};
function Modal({ children, open, onClose, title }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement, node = dialog.current;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, [open]);
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="settings-heading"><h2 id="settings-title">{title}</h2><button aria-label="关闭设置" onClick={onClose}>关闭</button></div>
    <div className="settings-content">{open && children}</div>
  </dialog>;
}
const Panel = createAssistantPanel(React, { Modal });
function App() {
  const [exited, setExited] = React.useState(false), [error, setError] = React.useState('');
  const exit = async () => { try { await adapter.command({ action: 'exit' }); setExited(true); } catch (error) { setError(error.message); } };
  return <><header><div><h1>语音助手</h1><p>随时开口，打断播报也能继续处理任务。</p></div><button onClick={exit} disabled={exited}>退出助手</button></header>{error && <p role="alert">{error}</p>}{exited ? <main>助手已退出，音频资源已释放。</main> : <Panel adapter={adapter} />}<footer>关闭这个页面不会停止助手。停止收听请使用“停止语音”，结束后台进程请使用“退出助手”。</footer></>;
}
createRoot(document.getElementById('root')).render(<App />);

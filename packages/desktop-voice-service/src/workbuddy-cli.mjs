import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {snapshotModelContext} from './model-context.mjs';

const outstanding = new Set();
let operationTail=Promise.resolve();

/** Catalog, model and search operations share one confirmed CLI owner. */
export function runWorkBuddyCli(options){
  const signal=options?.signal;if(signal?.aborted)return Promise.reject(Error('WORKBUDDY_REQUEST_CANCELLED'));
  let entered=false;
  const operation=operationTail.then(()=>{entered=true;signal?.throwIfAborted();return runOwnedWorkBuddyCli(options)});
  operationTail=operation.catch(()=>{});
  if(!signal)return operation;
  return new Promise((resolve,reject)=>{
    const aborted=()=>{if(!entered)reject(Error('WORKBUDDY_REQUEST_CANCELLED'))};
    signal.addEventListener('abort',aborted,{once:true});
    operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
    if(signal.aborted)aborted();
  });
}

/** Official domestic login owns credentials. No application API keys are inherited. */
export async function resolveWorkBuddyCli(config = {}) {
  const node = process.env.ASSISTANT_WORKBUDDY_NODE || config.node || process.execPath;
  const entry = process.env.ASSISTANT_WORKBUDDY_CLI || config.entry || join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  for (const path of [node, entry]) {
    if (!isAbsolute(path)) throw Error('WORKBUDDY_CLI_PATH_INVALID');
    try { if (!(await stat(path)).isFile()) throw Error('invalid'); }
    catch { throw Error('WORKBUDDY_CLI_NOT_INSTALLED'); }
  }
  try {
    const manifest=JSON.parse(await readFile(join(dirname(entry),'..','package.json'),'utf8'));
    if(manifest.name!=='@tencent-ai/codebuddy-code'||typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+/.test(manifest.version))throw Error('invalid');
  } catch { throw Error('WORKBUDDY_CLI_INSTALL_INVALID'); }
  return { node, entry };
}

function environment() {
  const values = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTHORIZATION|^CODEBUDDY_|^ANTHROPIC_/i.test(key)));
  values.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
  return values;
}

/** One owned CLI operation. Output is projected to text/models, never account payloads. */
async function runOwnedWorkBuddyCli({ model, prompt, systemPrompt = '', signal, onText = () => {},
  timeoutMs = 120000, spawnProcess = spawn, executable, directory, cli, nativeWebSearch = false }) {
  if (outstanding.size) throw Error('WORKBUDDY_CLI_EXIT_UNCONFIRMED');
  signal?.throwIfAborted();
  const { node, entry } = executable || await resolveWorkBuddyCli(cli);
  const work = directory || join(tmpdir(), 'rabi-assistant-workbuddy');
  await mkdir(work, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rabi-workbuddy-prompt-'));
  const args = [entry, '--print', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--permission-mode', 'dontAsk', '--tools', nativeWebSearch ? 'WebSearch' : '',
    '--strict-mcp-config', '--no-session-persistence'];
  if(nativeWebSearch)args.push('--allowedTools','WebSearch','--max-turns','3');
  const catalog = prompt === undefined;
  if (catalog) args.push('--input-format', 'stream-json');
  else {
    if (typeof model !== 'string' || !model.trim()) throw Error('ASSISTANT_MODEL_REQUIRED');
    args.push('--include-partial-messages', '--model', model);
    const file = join(temporary, 'system.txt');
    await writeFile(file, systemPrompt, { mode: 0o600 });
    args.push('--system-prompt-file', file);
  }
  let child, timer, cancelTimer, buffer = '', bytes = 0, emitted = '', result, models, failure;
  const searchCalls=new Set(),searchResults=[];
  const decoder = new StringDecoder('utf8');
  const cancel = () => {
    failure ||= Error(signal?.aborted ? 'WORKBUDDY_REQUEST_CANCELLED' : 'WORKBUDDY_REQUEST_TIMEOUT');
    // This child has no tools and no durable CLI transcript. EOF does not
    // cancel a running turn; terminate only our owned child and await close.
    child?.stdin.end();
    try { child?.kill('SIGTERM'); } catch { /* Keep ownership until close is observed. */ }
    cancelTimer ||= setTimeout(() => rejectOperation(Error('WORKBUDDY_CLI_EXIT_UNCONFIRMED')), 10000);
  };
  let rejectOperation;
  const operation = new Promise((resolve, reject) => {
    rejectOperation = reject;
    const fail = error => { failure ||= error; cancel(); };
    const receive = message => {
      if(message.type==='error'){
        const detail=typeof message.error==='string'?message.error:'';
        failure ||= Error(/Agent template is unavailable|Cannot find module|MODULE_NOT_FOUND/i.test(detail)?'WORKBUDDY_CLI_INSTALL_INVALID':'WORKBUDDY_CLI_FAILED');
        child.stdin.end();return;
      }
      if (message.type === 'control_request') {
        child.stdin.write(JSON.stringify({ type: 'control_response', response: {
          subtype: 'error', request_id: message.request_id, error: 'No client tools are available',
        } }) + '\n');
      }
      if (catalog && message.type === 'control_response') {
        const response = message.response;
        if (response?.request_id !== 'models' || response.subtype !== 'success') {
          fail(Error('WORKBUDDY_LOGIN_REQUIRED')); return;
        }
        const values = response.response?.models;
        if (!Array.isArray(values)) { fail(Error('WORKBUDDY_CATALOG_INVALID')); return; }
        models = values.map(item => ({ id: item.id || item.value,
          label: String(item.displayName || item.name || item.id || item.value).slice(0, 256) }))
          .filter(item => typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256);
        child.stdin.end();
      }
      if (message.type === 'system' && message.subtype === 'init' && !catalog && message.model !== model) {
        fail(Error('WORKBUDDY_MODEL_MISMATCH')); return;
      }
      if(nativeWebSearch){
        const blocks=message.type==='assistant'?message.message?.content:message.type==='stream_event'?[message.event?.content_block]:[];
        for(const block of blocks||[])if(block?.type==='tool_use'){
          if(block.name!=='WebSearch'){fail(Error('WORKBUDDY_SEARCH_TOOL_INVALID'));return;}
          searchCalls.add(block.id);
        }
        if(message.type==='user')for(const block of message.message?.content||[])if(block.type==='tool_result'&&searchCalls.has(block.tool_use_id)){
          if(block.is_error){fail(Error('WORKBUDDY_SEARCH_FAILED'));return;}
          const content=typeof block.content==='string'?block.content:(block.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n');
          if(typeof content==='string'&&content.length<=128000)searchResults.push(content);
        }
      }
      const delta = message.type === 'stream_event' && message.event?.type === 'content_block_delta'
        && message.event.delta?.type === 'text_delta' ? message.event.delta.text : '';
      if (!nativeWebSearch && typeof delta === 'string' && delta && !failure) {
        emitted += delta;
        if (emitted.length > 128000) { fail(Error('ASSISTANT_MODEL_RESPONSE_LIMIT')); return; }
        onText(delta);
      }
      if (message.type === 'result') {
        // Retain only the terminal answer, never the init account/token object.
        result = { success: message.subtype === 'success' && message.is_error === false,
          text: typeof message.result === 'string' ? message.result : '' };
      }
    };
    try {
      child = spawnProcess(node, args, { cwd: work, env: environment(), windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
      outstanding.add(child);
      child.stdin.on('error', () => fail(Error('WORKBUDDY_INPUT_FAILED')));
      child.stderr.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) fail(Error('WORKBUDDY_OUTPUT_LIMIT'));
      });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { fail(Error('WORKBUDDY_OUTPUT_LIMIT')); return; }
        buffer += decoder.write(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try { receive(JSON.parse(line)); }
          catch { fail(Error('WORKBUDDY_PROTOCOL_INVALID')); }
        }
      });
      child.on('error', () => { failure ||= Error('WORKBUDDY_CLI_START_FAILED'); });
      child.on('close', (code, exitSignal) => {
        outstanding.delete(child);
        clearTimeout(timer); clearTimeout(cancelTimer);
        signal?.removeEventListener('abort', cancel);
        if (failure) { reject(failure); return; }
        if (code !== 0 || exitSignal) { reject(Error('WORKBUDDY_CLI_FAILED')); return; }
        if (catalog) {
          if (!models?.length) reject(Error('WORKBUDDY_CATALOG_EMPTY'));
          else resolve(models);
          return;
        }
        if (!result?.success || !result.text) { reject(Error('WORKBUDDY_REPLY_FAILED')); return; }
        if(nativeWebSearch){
          if(!searchResults.length){reject(Error('WORKBUDDY_SEARCH_NOT_EXECUTED'));return;}
          resolve({results:searchResults});return;
        }
        if (!result.text.startsWith(emitted)) { reject(Error('WORKBUDDY_STREAM_MISMATCH')); return; }
        if (result.text.length > emitted.length) onText(result.text.slice(emitted.length));
        resolve(result.text);
      });
      timer = setTimeout(cancel, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else if (catalog) child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models',
        request: { subtype: 'initialize', hasPrompt: false } }) + '\n');
      else child.stdin.end(prompt);
    } catch { reject(Error('WORKBUDDY_CLI_START_FAILED')); }
  });
  try { return await operation; }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Same model port as compatible providers, with bounded in-memory conversation. */
export function createWorkBuddyModel({ model, initialPrompts = [], signal, runner = runWorkBuddyCli,cli,initialHistory=[],onHistoryChange=()=>{},projectAssistantHistory=raw=>raw }) {
  const lifetime = new AbortController();
  let history = snapshotModelContext(initialHistory), busy = false;
  return {
    async promptStreaming(input) {
      if (busy) throw Error('ASSISTANT_MODEL_BUSY');
      busy = true;
      const abort = new AbortController();
      const requestSignal = AbortSignal.any([lifetime.signal, abort.signal, ...(signal ? [signal] : [])]);
      const queue = [];
      let wake, done = false, failure;
      const notify = () => { wake?.(); wake = undefined; };
      const systemPrompt = initialPrompts.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
      const prompt = JSON.stringify({ messages: [
        ...initialPrompts.filter(item => item.role !== 'system'), ...history, ...input,
      ] });
      const operation = runner({ model, prompt, systemPrompt, cli, signal: requestSignal,
        onText: text => { queue.push(text); notify(); } }).then(text => {
        history=snapshotModelContext([...history,...input,{role:'assistant',content:projectAssistantHistory(text,input)}]);
        onHistoryChange(snapshotModelContext(history));
      }).catch(error => { failure = error; }).finally(() => { done = true; busy = false; notify(); });
      return {
        async read() {
          while (!done && !queue.length) await new Promise(resolve => { wake = resolve; });
          if (failure) throw failure;
          if (queue.length) return { done: false, value: queue.shift() };
          return { done: true };
        },
        async cancel() { abort.abort(); await operation; },
      };
    },
    destroy() { lifetime.abort(); history = []; },
  };
}

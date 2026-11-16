import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

export function createLocalRecognizer(options = {}) {
  const configured = ['python', 'model', 'dependencies'].every(key =>
    typeof options[key] === 'string' && isAbsolute(options[key]));
  return {
    configured,
    async recognize(audio, signal) {
      if (!configured) throw Error('LOCAL_ASR_NOT_CONFIGURED');
      if (!(audio instanceof Uint8Array) || audio.length > 4 * 1024 * 1024) throw Error('SPEECH_AUDIO_LIMIT');
      for (const path of [options.python, options.model, options.dependencies]) {
        try { await stat(path); } catch { throw Error('LOCAL_ASR_NOT_CONFIGURED'); }
      }
      signal?.throwIfAborted();
      const names = new Set(['SYSTEMROOT','WINDIR','TEMP','TMP','PATH','USERPROFILE','LOCALAPPDATA','APPDATA']);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toUpperCase())));
      Object.assign(env, { PYTHONPATH: options.dependencies, PYTHONIOENCODING:'utf-8',
        HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1' });
      return new Promise((resolve, reject) => {
        let output = '', failed = false;
        const child = spawn(options.python, [fileURLToPath(new URL('./local-asr.py', import.meta.url)), options.model],
          { env, windowsHide:true, stdio:['pipe','pipe','pipe'], signal, timeout:60000 });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) { failed=true; child.kill(); } });
        child.stderr.resume();
        child.on('error', () => { failed=true; });
        child.stdin.on('error', () => { failed=true; });
        child.on('close', code => {
          if (code !== 0 || failed) { reject(Error('LOCAL_ASR_FAILED')); return; }
          try {
            const result=JSON.parse(output);
            if (typeof result.text !== 'string') throw Error('invalid');
            resolve({text:result.text});
          } catch { reject(Error('LOCAL_ASR_FAILED')); }
        });
        child.stdin.end(JSON.stringify({audio:Buffer.from(audio).toString('base64')}));
      });
    },
  };
}

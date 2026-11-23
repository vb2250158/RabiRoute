import {join,resolve} from 'node:path';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {createManagedResidentSpeech} from '../../../packages/desktop-voice-service/src/resident-speech.mjs';
import {openAssistantRuntime} from './runtime.mjs';
import {openAccessToken} from './access-store.mjs';
import {openAssistantServer} from './server.mjs';

/** The standalone process adds only its loopback server, browser authentication and process exit. */
export async function startStandalone({directory,publicDirectory,port=0,deviceFactory,providerFactory,residentSpeech,managedSpeech,onExit=()=>{}}){
  let server,runtime,closing;
  const localSpeech=managedSpeech&&createManagedResidentSpeech(managedSpeech);
  const disposeRuntime=()=>closing??=(async()=>{
    try{await runtime?.dispose();}finally{await localSpeech?.dispose();}
  })();
  try {
    runtime=await openAssistantRuntime({directory,deviceFactory,providerFactory,residentSpeech:localSpeech||residentSpeech,
      onOpenSettings:()=>server&&runtime.host.openSettings(server.origin+'/?voice-assistant=1')});
    server=await openAssistantServer({host:{...runtime,dispose:disposeRuntime},messages:runtime.messages,
      directory:publicDirectory,port,onExit,accessToken:await openAccessToken(directory)});
  } catch(error) { await disposeRuntime();throw error; }
  return {...server,state:runtime.state,async dispose(){try{await disposeRuntime();}finally{await server.close();}}};
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replaceAll('\\', '/')).href) {
  const directory = process.env.ASSISTANT_DATA_DIR || join(process.env.LOCALAPPDATA, 'RabiAssistant');
  await mkdir(directory, { recursive: true });
  let app;
  const readyPath = join(directory, 'ready.json');
  const workspaceRoot = resolve(directory, 'resident-speech');
  const executable = process.env.ASSISTANT_RESIDENT_SPEECH_EXECUTABLE;
  const managedSpeech = executable ? { executable, workspaceRoot,
    configPath: join(workspaceRoot, 'config.json'),
    serviceRoot: process.env.ASSISTANT_RESIDENT_SPEECH_SERVICE_ROOT || undefined,
    dependenciesRoot: process.env.ASSISTANT_RESIDENT_SPEECH_DEPS_ROOT || undefined,
    pythonHome: process.env.ASSISTANT_RESIDENT_SPEECH_PYTHON_HOME || undefined,
    modelRoot: process.env.ASSISTANT_RESIDENT_SPEECH_MODEL_ROOT || undefined } : undefined;
  const exit = async () => { await rm(readyPath, { force: true }); process.exitCode = 0; };
  try {
    app = await startStandalone({ directory, publicDirectory: join(import.meta.dirname, '../public'), port: Number(process.env.ASSISTANT_PORT || 0), managedSpeech, onExit: exit });
    await writeFile(readyPath, JSON.stringify({ pid: process.pid, url: app.url, startedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('ASSISTANT_READY ' + app.origin);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await app.dispose(); await exit(); } catch { console.error('ASSISTANT_CLEANUP_UNCONFIRMED'); process.exitCode = 1; } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'ASSISTANT_START_FAILED'); process.exitCode = 1; }
}

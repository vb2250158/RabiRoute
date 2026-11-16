import {join} from 'node:path';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {openAssistantRuntime} from './runtime.mjs';
import {openAccessToken} from './access-store.mjs';
import {openAssistantServer} from './server.mjs';

/** The standalone process adds only its loopback server, browser authentication and process exit. */
export async function startStandalone({directory,publicDirectory,port=0,deviceFactory,providerFactory,onExit=()=>{}}){
  let server;
  const runtime=await openAssistantRuntime({directory,deviceFactory,providerFactory,onOpenSettings:()=>server&&runtime.host.openSettings(server.origin+'/?voice-assistant=1')});
  try{server=await openAssistantServer({host:runtime,messages:runtime.messages,directory:publicDirectory,port,onExit,accessToken:await openAccessToken(directory)});}
  catch(error){await runtime.dispose();throw error}
  return {...server,state:runtime.state,async dispose(){await runtime.dispose();await server.close()}};
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replaceAll('\\', '/')).href) {
  const directory = process.env.ASSISTANT_DATA_DIR || join(process.env.LOCALAPPDATA, 'RabiAssistant');
  await mkdir(directory, { recursive: true });
  let app;
  const readyPath = join(directory, 'ready.json');
  const exit = async () => { await rm(readyPath, { force: true }); process.exitCode = 0; };
  try {
    app = await startStandalone({ directory, publicDirectory: join(import.meta.dirname, '../public'), port: Number(process.env.ASSISTANT_PORT || 0), onExit: exit });
    await writeFile(readyPath, JSON.stringify({ pid: process.pid, url: app.url, startedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('ASSISTANT_READY ' + app.origin);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await app.dispose(); await exit(); } catch { console.error('ASSISTANT_CLEANUP_UNCONFIRMED'); process.exitCode = 1; } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'ASSISTANT_START_FAILED'); process.exitCode = 1; }
}

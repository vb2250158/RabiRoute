import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {transformWindowsSecret} from '@rabilink/desktop-voice-service/windows-secrets';
export const validAccessToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
/** One private, revocable capability per standalone data directory. Never returned by public HTTP. */
export async function openAccessToken(directory,{protect=value=>transformWindowsSecret(value,false),unprotect=value=>transformWindowsSecret(value,true),initialToken}={}) {
  const path=join(directory,'access.json');
  const existing=async()=>{let doc;try{doc=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')throw error;throw Error('ASSISTANT_ACCESS_FILE_INVALID')}
    if(doc.version!==1||typeof doc.encrypted!=='string'||doc.encrypted.length>16384)throw Error('ASSISTANT_ACCESS_FILE_INVALID');
    let token;try{token=await unprotect(doc.encrypted)}catch{throw Error('ASSISTANT_ACCESS_FILE_INVALID')}if(!validAccessToken(token))throw Error('ASSISTANT_ACCESS_FILE_INVALID');return token;};
  try{return await existing()}catch(error){if(error.code!=='ENOENT')throw error}
  const token=initialToken===undefined?randomBytes(32).toString('base64url'):initialToken;if(!validAccessToken(token))throw Error('ASSISTANT_ACCESS_TOKEN_INVALID');
  const encrypted=await protect(token);
  try{await writeFile(path,JSON.stringify({version:1,encrypted}),{encoding:'utf8',mode:0o600,flag:'wx'});return token}
  catch(error){if(error.code!=='EEXIST')throw error;return existing()}
}

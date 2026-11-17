import {DatabaseSync} from 'node:sqlite';
import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {transformWindowsSecret} from '@rabilink/desktop-voice-service/windows-secrets';

const newId=()=> 'local-'+randomUUID().slice(0,30);
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9:._-]{1,40}$/.test(id);
const failed=(code,cause)=>Object.assign(new Error(code,{cause}),{code});

/** One local owner. Content is AES-GCM encrypted; DPAPI CurrentUser wraps its key. */
export async function openConversationStore(directory,{protect=value=>transformWindowsSecret(value),unprotect=value=>transformWindowsSecret(value,true),initialId}={}){
 if(initialId!==undefined&&!validId(initialId))throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
 await mkdir(directory,{recursive:true});
 const lockPath=join(directory,'conversation.lock'),lease=JSON.stringify({pid:process.pid,token:randomUUID()});
 let lock,db,key;
 try{
  try{lock=await open(lockPath,'wx',0o600)}catch(error){
   if(error.code!=='EEXIST')throw error;
   const old=await readFile(lockPath,'utf8');let owner;try{owner=JSON.parse(old)}catch{throw failed('ASSISTANT_CONTEXT_IN_USE')}
   if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw failed('ASSISTANT_CONTEXT_IN_USE');
   try{process.kill(owner.pid,0);throw failed('ASSISTANT_CONTEXT_IN_USE')}catch(e){if(e.code!=='ESRCH')throw e}
   if(await readFile(lockPath,'utf8')!==old)throw failed('ASSISTANT_CONTEXT_IN_USE');
   await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
  }
  await lock.writeFile(lease);await lock.sync();
  db=new DatabaseSync(join(directory,'conversation.sqlite'),{timeout:1500});
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,payload BLOB NOT NULL);');
  const meta=name=>db.prepare('SELECT value FROM metadata WHERE name=?').get(name)?.value;
  const setMeta=(name,value)=>db.prepare('INSERT INTO metadata(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,value);
  const transaction=action=>{db.exec('BEGIN IMMEDIATE');try{const value=action();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}};
  if(!meta('version')){
   if(db.prepare('SELECT count(*) AS n FROM messages').get().n||db.prepare('SELECT count(*) AS n FROM metadata').get().n)throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
   key=randomBytes(32);const wrapped=await protect(key.toString('base64'));
   transaction(()=>{setMeta('version','1');setMeta('key',wrapped);setMeta('id',initialId||newId());});
  }else{
   if(meta('version')!=='1')throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
   key=Buffer.from(await unprotect(meta('key')),'base64');if(key.length!==32)throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
  }
  const encode=value=>{const data=Buffer.from(JSON.stringify(value));if(data.length>2*1024*1024)throw failed('ASSISTANT_CONTEXT_RECORD_LIMIT');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(data),cipher.final(),cipher.getAuthTag()])};
  const decode=payload=>{const bytes=Buffer.from(payload);if(bytes.length<28||bytes.length>2*1024*1024+28)throw failed('ASSISTANT_CONTEXT_FILE_INVALID');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString())};
  const context=()=>meta('context')?decode(Buffer.from(meta('context'),'base64')):[];
  if(!validId(meta('id'))||!Array.isArray(context()))throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
  const upsert=db.prepare('INSERT INTO messages(id,role,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload');
  const put=message=>{
   if(!message||typeof message.id!=='string'||message.id.length>160||!['user','assistant'].includes(message.role)||typeof message.text!=='string')throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
   const existing=db.prepare('SELECT role FROM messages WHERE id=?').get(message.id);if(existing&&existing.role!==message.role)throw failed('ASSISTANT_CONTEXT_FILE_INVALID');
   upsert.run(message.id,message.role,message.status||'completed',encode(message));
  };
  let interruptedCount=0;
  const interrupted=db.prepare("SELECT payload FROM messages WHERE status IN ('queued','generating') ORDER BY seq").all();
  transaction(()=>{for(const row of interrupted){const message=decode(row.payload);message.status='interrupted';if(message.role==='user')interruptedCount++;put(message)}});
  transaction(()=>{for(const row of db.prepare('SELECT payload FROM messages ORDER BY seq DESC LIMIT 100').all()){
   const message=decode(row.payload),details=message.details;
   if(details?.kind!=='tts'||!details.requests?.length||['ended','cancelled','error'].includes(details.playback?.status))continue;
   details.playback={status:'cancelled',reason:'process-restarted'};
   for(const request of details.requests)if(!['completed','failed','cancelled'].includes(request.stage))request.stage='cancelled';
   put(message);
  }});
  let closed=false;
  return {
   read(){return{id:meta('id'),context:context(),interruptedCount,...(meta('canvas')?{canvas:decode(Buffer.from(meta('canvas'),'base64'))}:{})}},
   count:()=>db.prepare('SELECT count(*) AS n FROM messages').get().n,
   find(id){const row=db.prepare('SELECT payload FROM messages WHERE id=?').get(id);return row?decode(row.payload):undefined},
   page({before,limit=100}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||before!==undefined&&(typeof before!=='string'||before.length>160))throw failed('ASSISTANT_CONTEXT_PAGE_INVALID');
    const cursor=before?db.prepare('SELECT seq FROM messages WHERE id=?').get(before)?.seq:undefined;
    if(before&&cursor===undefined)throw failed('ASSISTANT_CONTEXT_PAGE_INVALID');
    const rows=cursor===undefined?db.prepare('SELECT payload FROM messages ORDER BY seq DESC LIMIT ?').all(limit+1):db.prepare('SELECT payload FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?').all(cursor,limit+1);
    return{messages:rows.slice(0,limit).reverse().map(row=>decode(row.payload)),hasMore:rows.length>limit};
   },
   commit({id,messages=[],context:nextContext,canvas}){
    if(closed)throw failed('ASSISTANT_CONTEXT_CLOSED');
    try{transaction(()=>{if(id!==meta('id'))throw failed('ASSISTANT_CONTEXT_CHANGED');for(const message of messages)put(message);if(nextContext!==undefined)setMeta('context',encode(nextContext).toString('base64'));if(canvas!==undefined)setMeta('canvas',encode(canvas).toString('base64'));setMeta('savedAt',new Date().toISOString())})}catch(e){throw failed(e.code==='ASSISTANT_CONTEXT_CHANGED'?e.code:'ASSISTANT_CONTEXT_SAVE_FAILED',e)}
   },
   clear(expectedId){
    if(expectedId!==meta('id'))throw failed('ASSISTANT_CONTEXT_CHANGED');
    const id=newId();transaction(()=>{db.exec('DELETE FROM messages');db.prepare('DELETE FROM metadata WHERE name=?').run('canvas');setMeta('id',id);setMeta('context',encode([]).toString('base64'));setMeta('savedAt',new Date().toISOString())});interruptedCount=0;return id;
   },
   async close(){if(closed)return;closed=true;try{db.close()}finally{key.fill(0);await lock.close();if(await readFile(lockPath,'utf8')===lease)await unlink(lockPath)}}
  };
 }catch(error){try{db?.close();key?.fill(0)}finally{if(lock){await lock.close();try{if(await readFile(lockPath,'utf8')===lease)await unlink(lockPath)}catch{}}}throw failed(error.code?.startsWith('ASSISTANT_CONTEXT_')?error.code:'ASSISTANT_CONTEXT_LOAD_FAILED',error)}
}

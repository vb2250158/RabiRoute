import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type http from 'node:http';
import fs, { constants, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { ReadStream } from 'node:fs';
import { ManagerReadWorkerError } from './managerReadWorkerPool.js';
import { roleSkillArchiveLimits } from './roleSkillArchive.js';
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from './personaResourceAdmission.js';
import { isPortableSkillArchiveSegment } from '../shared/skillArchivePath.js';
import { sanitizeRoleId } from '../shared/routeIdentity.js';

export type RoleSkillArchiveReply =
  | { ok: true; sizeBytes: number; sha256: string; fileCount: number }
  | { ok: false; code: "not_found" | "unsafe_path" | "too_large" | "conflict" };

export const roleSkillDownloadPolicy = Object.freeze({ maxActiveLeases: 4, transferTimeoutMs: 30_000 });

/** Includes generation, slow transfers and quarantined workers; not just pool slots. */
export class RoleSkillDownloadAdmission {
  private leases = 0;
  constructor(private readonly limit: number = roleSkillDownloadPolicy.maxActiveLeases) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid download lease limit.");
  }
  get active(): number { return this.leases; }
  acquire(): (() => void) | undefined {
    if (this.leases >= this.limit) return undefined;
    this.leases++;
    let released = false;
    return () => { if (!released) { released = true; this.leases--; } };
  }
}
const downloadAdmission = new RoleSkillDownloadAdmission();

export type RoleSkillDownloadContext = {
  identity?(): PersonaResourceIdentity;
  roleDirectory: (roleId: string) => string;
  archive: (roleDir: string, skillId: string, outputPath: string, options: {
    signal: AbortSignal;
    /** Must be invoked on late confirmed worker exit after termination_unconfirmed. */
    onWorkerReleased: () => void;
  }) => Promise<RoleSkillArchiveReply>;
  /** Existing host error logging; do not log private source or archive paths. */
  reportCleanupError: () => void;
  temporaryRoot?: string;
  admission?: RoleSkillDownloadAdmission;
  transferTimeoutMs?: number;
};

const archiveErrorStatus={not_found:404,unsafe_path:403,too_large:413,conflict:409} as const;
export const ROLE_SKILL_DOWNLOAD_FRAME_BYTES=64*1024;
function fail(statusCode:number,code:string):never {throw Object.assign(new Error(code),{statusCode,publicCode:code});}

/** Native private archive lease; the original pool retains quarantined worker ownership. */
export function createRoleSkillDownloadOwner(context:RoleSkillDownloadContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,skillId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity);
    if(!isPortableSkillArchiveSegment(roleId)||sanitizeRoleId(roleId)!==roleId||!isPortableSkillArchiveSegment(skillId)||skillId.includes('%'))fail(403,'INVALID_SKILL_DOWNLOAD_PATH');
    const roleDir=context.roleDirectory(roleId);
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Persona directory changed while archiving the original Skill.'),{statusCode:409});};
    return {async archive(hasQuery:boolean) {
      assertCurrent();if(hasQuery)fail(400,'SKILL_DOWNLOAD_QUERY_NOT_SUPPORTED');
      const releaseLease=(context.admission??downloadAdmission).acquire();
      if(!releaseLease)fail(503,'SKILL_DOWNLOAD_BUSY');
      const controller=new AbortController();
      const abort=()=>controller.abort(signal?.reason);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      let lease:string|undefined,file:FileHandle|undefined,stream:ReadStream|undefined,closed:Promise<void>|undefined;
      let workerReleased=false,quarantined=false,timer:ReturnType<typeof setTimeout>|undefined,cleanupFlight:Promise<void>|undefined;
      const cleanup=()=>cleanupFlight??=(async()=>{
        if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);
        stream?.destroy();if(closed)await closed;if(file)await file.close();
        if(lease){
          const parent=path.resolve(context.temporaryRoot??os.tmpdir());
          if(path.dirname(path.resolve(lease))!==parent||!path.basename(lease).startsWith('rabiroute-skill-'))throw new Error('Invalid private archive cleanup target.');
          await fs.rm(lease,{recursive:true,force:true});
        }
        releaseLease!();
      })().catch(error=>{context.reportCleanupError();throw error;});
      const onWorkerReleased=()=>{workerReleased=true;if(quarantined)void cleanup().catch(()=>{});};
      try {
        controller.signal.throwIfAborted();assertCurrent();
        lease=await fs.mkdtemp(path.join(context.temporaryRoot??os.tmpdir(),'rabiroute-skill-'));
        controller.signal.throwIfAborted();assertCurrent();
        const outputPath=path.join(lease,'download.zip');
        const result=await context.archive(roleDir,skillId,outputPath,{signal:controller.signal,onWorkerReleased});
        controller.signal.throwIfAborted();assertCurrent();
        if(!result.ok)fail(archiveErrorStatus[result.code],'SKILL_ARCHIVE_'+result.code.toUpperCase());
        if(!Number.isSafeInteger(result.sizeBytes)||result.sizeBytes<22||result.sizeBytes>roleSkillArchiveLimits.maxArchiveBytes||!/^[a-f0-9]{64}$/i.test(result.sha256))throw new Error('Invalid archive result.');
        const timeout=context.transferTimeoutMs?? getTimeoutMs("persona.skillDownload", roleSkillDownloadPolicy.transferTimeoutMs);
        if(!Number.isSafeInteger(timeout)||timeout<1)throw new Error('Invalid transfer timeout.');
        timer=setTimeout(()=>controller.abort(new Error('Skill transfer deadline exceeded.')),timeout);timer.unref();
        file=await fs.open(outputPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
        const stat=await file.stat();
        if(!stat.isFile()||stat.nlink!==1||stat.size!==result.sizeBytes)throw new Error('Invalid archive artifact.');
        controller.signal.throwIfAborted();assertCurrent();
        stream=file.createReadStream({highWaterMark:ROLE_SKILL_DOWNLOAD_FRAME_BYTES,signal:controller.signal});
        closed=finished(stream).then(()=>{},()=>{});
        const ownedStream=stream;
        const frames=(async function*(){try{for await(const chunk of ownedStream){assertCurrent();yield Buffer.from(chunk);}}finally{await cleanup();}})();
        const asciiName=`${skillId}.zip`.replace(/[^A-Za-z0-9._-]/g,'_');
        return {headers:{'content-type':'application/zip','content-length':String(result.sizeBytes),'content-disposition':`attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${skillId}.zip`).replace(/'/g,'%27')}`,
          'x-rabiroute-content-sha256':result.sha256.toLowerCase(),etag:`"sha256-${result.sha256.toLowerCase()}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'},
          stream:{frames,signal:controller.signal,async cancel(reason?:unknown){controller.abort(reason);await cleanup();}}};
      }catch(error){
        if(error instanceof ManagerReadWorkerError&&error.code==='termination_unconfirmed')quarantined=!workerReleased;
        if(!quarantined)await cleanup();
        else{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        throw error;
      }
    }};
  }};
}

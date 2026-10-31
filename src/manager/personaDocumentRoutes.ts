import fs from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { personaReadSettings } from "../shared/personaReadSettings.js";
import type http from "node:http";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";
import path from "node:path";

// Wire capacity; the selected document owner applies the configured quota.
export const PERSONA_DOCUMENT_MAX_BYTES = bufferConstants.MAX_LENGTH;

const fail = (statusCode:number, message:string):never => { throw Object.assign(new Error(message), {statusCode}); };
export function createPersonaDocumentOwner(options:{roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity}) {
  return {
    prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
      const admission=preparePersonaResourceAdmission(request,signal,options.identity);
      const resolvedRoleDir=path.resolve(options.roleDirectory(roleId));
      const assertCurrent=()=>{admission();if(path.resolve(options.roleDirectory(roleId))!==resolvedRoleDir)fail(409,"Persona directory changed while reading the original document.");};
      return {
        read(rawFile:string|null) {
          assertCurrent();
          const PERSONA_DOCUMENT_MAX_BYTES = personaReadSettings.documentBytes || bufferConstants.MAX_LENGTH;
          const fileName=rawFile?.trim() || "persona.md";
          if(path.basename(fileName)!==fileName || !/\.(?:md|markdown)$/i.test(fileName)) fail(400,"Persona document must be one Markdown file name.");
          const targetPath=path.resolve(resolvedRoleDir,fileName);
          if(path.dirname(targetPath)!==resolvedRoleDir)fail(400,"Persona document path leaves the role directory.");
          if(!fs.existsSync(targetPath))fail(404,"Persona document was not found.");
          const stat=fs.statSync(targetPath);
          if(!stat.isFile())fail(400,"Persona document is not a file.");
          if(stat.size>PERSONA_DOCUMENT_MAX_BYTES)fail(413,`RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=${personaReadSettings.documentBytes} exceeded; increase this Manager environment setting or set 0 to remove the application quota.`);
          const realRoleDir=fs.realpathSync(resolvedRoleDir), realTargetPath=fs.realpathSync(targetPath);
          if(path.dirname(realTargetPath)!==realRoleDir)fail(403,"Persona document resolves outside the role directory.");
          let bytes: Buffer;
          try { bytes=fs.readFileSync(realTargetPath); } catch (error) {
            if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === "ERR_FS_FILE_TOO_LARGE") fail(503,"Persona document exceeds the current runtime buffer capacity.");
            throw error;
          }
          if(bytes.length>PERSONA_DOCUMENT_MAX_BYTES)fail(413,`RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=${personaReadSettings.documentBytes} exceeded; increase this Manager environment setting or set 0 to remove the application quota.`);
          assertCurrent();return bytes;
        }
      };
    }
  };
}

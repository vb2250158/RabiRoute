import koffi from 'koffi';
let api;
/** DPAPI CurrentUser, UI forbidden. No shell process or secret-bearing command line. */
export function transformWindowsSecret(value, decrypt=false) {
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('ASSISTANT_CREDENTIAL_PLATFORM_UNSUPPORTED');
  if(!api){
    const blob=koffi.struct('RabiAssistantSecretBlob',{cbData:'uint32',pbData:'void *'});
    const crypt=koffi.load('crypt32.dll'),kernel=koffi.load('kernel32.dll');
    const args=[koffi.pointer(blob),'void *','void *','void *','void *','uint32',koffi.out(koffi.pointer(blob))];
    api={protect:crypt.func('__stdcall','CryptProtectData','int',args),unprotect:crypt.func('__stdcall','CryptUnprotectData','int',args),free:kernel.func('__stdcall','LocalFree','void *',['void *'])};
  }
  const input=Buffer.from(value,decrypt?'base64':'utf8'),output={};
  if(input.length>65536)throw Error('ASSISTANT_CREDENTIAL_STORE_FAILED');
  try{
    if(!(decrypt?api.unprotect:api.protect)({cbData:input.length,pbData:input},null,null,null,null,1,output))throw Error('ASSISTANT_CREDENTIAL_STORE_FAILED');
    if(output.cbData>65536)throw Error('ASSISTANT_CREDENTIAL_STORE_FAILED');
    return Buffer.from(koffi.decode(output.pbData,'uint8_t',output.cbData)).toString(decrypt?'utf8':'base64');
  }finally{input.fill(0);if(output.pbData)api.free(output.pbData)}
}

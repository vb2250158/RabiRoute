import koffi from 'koffi';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Windows x64 ABI. A Job is attached by CreateProcess itself, rather than a
// later AssignProcessToJobObject call that leaves a parent-death race.
let api;
function bindings() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('WINDOWS_X64_REQUIRED');
  if (api) return api;
  const kernel = koffi.load('kernel32.dll');
  const bind = (name, result, args) => kernel.func('__stdcall', name, result, args);
  api = {
    job: bind('CreateJobObjectW', 'void *', ['void *', 'str16']),
    limits: bind('SetInformationJobObject', 'int', ['void *', 'int', 'void *', 'uint32']),
    query: bind('QueryInformationJobObject', 'int', ['void *', 'int', 'void *', 'uint32', 'void *']),
    initialize: bind('InitializeProcThreadAttributeList', 'int', ['void *', 'uint32', 'uint32', 'void *']),
    attribute: bind('UpdateProcThreadAttribute', 'int', ['void *', 'uint32', 'uintptr_t', 'void *', 'size_t', 'void *', 'void *']),
    destroy: bind('DeleteProcThreadAttributeList', 'void', ['void *']),
    create: bind('CreateProcessW', 'int', ['str16', 'void *', 'void *', 'void *', 'int', 'uint32', 'void *', 'str16', 'void *', 'void *']),
    resume: bind('ResumeThread', 'uint32', ['void *']),
    terminate: bind('TerminateJobObject', 'int', ['void *', 'uint32']),
    close: bind('CloseHandle', 'int', ['void *']),
    wait: bind('WaitForSingleObject', 'uint32', ['void *', 'uint32']),
    exitCode: bind('GetExitCodeProcess', 'int', ['void *', 'void *']),
    error: bind('GetLastError', 'uint32', []),
    flags: bind('GetHandleInformation', 'int', ['void *', 'void *']),
  };
  return api;
}
function checked(ok, label) { if (!ok) throw Object.assign(Error(label + ' failed: ' + bindings().error()), { code: 'WINDOWS_JOB_ERROR' }); }
function quote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw Error('PROCESS_ARGUMENT_INVALID');
  if (value && !/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function environment(values) {
  const entries = new Map();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || name.includes('=') || name.includes('\0') || value.includes('\0')) throw Error('PROCESS_ENV_INVALID');
    const key = name.toUpperCase(), old = entries.get(key);
    if (old && old[1] !== value) throw Error('PROCESS_ENV_CASE_CONFLICT');
    entries.set(key, [name, value]);
  }
  return Buffer.from([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, [k, v]]) => k + '=' + v).join('\0') + '\0\0', 'utf16le');
}
/** Hold this object in the actual host realm. It never transfers the Job handle. */
export function spawnOwnedProcess({ executable, args = [], cwd, env = {}, cleanupTimeoutMs = 10000, startSuspended = false }) {
  if (!isAbsolute(executable) || !isAbsolute(cwd)) throw Error('PROCESS_ABSOLUTE_PATH_REQUIRED');
  const native = bindings(), job = native.job(null, null);
  checked(job, 'CreateJobObjectW');
  let attributes, initialized = false, processHandle, thread, stopping;
  const close = (handle, label) => checked(native.close(handle), label);
  try {
    const flags = Buffer.alloc(4);
    checked(native.flags(job, flags), 'GetHandleInformation');
    if (flags.readUInt32LE() & 1) throw Error('JOB_MUST_NOT_BE_INHERITABLE');
    const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
    checked(native.limits(job, 9, limits, limits.length), 'SetInformationJobObject');
    const size = Buffer.alloc(8);
    native.initialize(null, 1, 0, size);
    const bytes = Number(size.readBigUInt64LE());
    if (bytes < 1 || bytes > 65536) throw Error('JOB_ATTRIBUTE_SIZE_INVALID');
    attributes = koffi.alloc('uint8', bytes);
    checked(native.initialize(attributes, 1, 0, size), 'InitializeProcThreadAttributeList');
    initialized = true;
    const jobs = Buffer.alloc(8); koffi.encode(jobs, 'void *', job);
    checked(native.attribute(attributes, 0, 0x2000d, jobs, jobs.length, null, null), 'UpdateProcThreadAttribute(JobList)');
    const startup = Buffer.alloc(112);
    startup.writeUInt32LE(112, 0); startup.writeUInt32LE(1, 60);
    koffi.encode(startup.subarray(104), 'void *', attributes);
    const info = Buffer.alloc(24);
    const command = Buffer.from([executable, ...args].map(quote).join(' ') + '\0', 'utf16le');
    // No inherited handles: in particular the child cannot retain our Job.
    checked(native.create(executable, command, null, null, 0, 0x08080404, environment(env), cwd, startup, info), 'CreateProcessW(JobList)');
    processHandle = koffi.decode(info, 'void *');
    thread = koffi.decode(info.subarray(8), 'void *');
    const pid = info.readUInt32LE(16);
    if (!processHandle || !thread || !pid) throw Error('PROCESS_INFORMATION_INVALID');
    const resume = () => {
      if (!thread) return;
      if (native.resume(thread) === 0xffffffff) checked(false, 'ResumeThread');
      close(thread, 'CloseHandle(thread)'); thread = null;
    };
    if (!startSuspended) resume();
    let closed = false;
    const exitCode = () => {
      if (closed) return null;
      const wait = native.wait(processHandle, 0);
      if (wait === 258) return undefined;
      if (wait !== 0) checked(false, 'WaitForSingleObject');
      const code = Buffer.alloc(4); checked(native.exitCode(processHandle, code), 'GetExitCodeProcess');
      return code.readUInt32LE();
    };
    const empty = () => {
      const accounting = Buffer.alloc(48);
      checked(native.query(job, 1, accounting, accounting.length, null), 'QueryInformationJobObject');
      return accounting.readUInt32LE(40) === 0;
    };
    return Object.freeze({
      pid, exitCode, resume,
      dispose() {
        if (stopping) return stopping;
        stopping = (async () => {
          checked(native.terminate(job, 0), 'TerminateJobObject');
          const deadline = Date.now() + cleanupTimeoutMs;
          while (!empty() && Date.now() < deadline) await delay(20);
          if (!empty()) throw Error('PROCESS_CLEANUP_UNCONFIRMED');
          if (thread) { close(thread, 'CloseHandle(thread)'); thread = null; }
          close(processHandle, 'CloseHandle(process)'); processHandle = null;
          close(job, 'CloseHandle(job)'); closed = true;
        })();
        return stopping;
      },
    });
  } catch (error) {
    if (thread) native.close(thread);
    native.terminate(job, 1);
    if (processHandle) native.close(processHandle);
    native.close(job);
    throw error;
  } finally {
    if (initialized) native.destroy(attributes);
    if (attributes) koffi.free(attributes);
  }
}

/** Child receives only ordinary OS settings, never Host API credentials. */
export function deviceEnvironment(source = process.env) {
  const names = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'COMSPEC', 'PATHEXT']);
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => names.has(name.toUpperCase()) && typeof value === 'string'));
}

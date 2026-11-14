import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export const POSIX_OWNER_PROTOCOL = 2;
const runtimes = new Map();

/** Serialized into the stable launcher: only builtins and one pinned native addon are used. */
export function createPosixOwnerLeaseRuntime({ fs, path, createHash, requireNative, nativeSpec }) {
  if (!['linux', 'darwin'].includes(process.platform) || typeof process.getuid !== 'function'
      || !Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error('POSIX owner leases require Linux or macOS with O_NOFOLLOW.');
  const uid = process.getuid();
  const regular = stat => {
    if (!stat.isFile() || Number(stat.uid) !== uid || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o777) !== 0o600)
      throw new Error('Owner lease must be a 0600 singly linked regular file owned by the current user.');
  };
  const directory = filename => {
    try { fs.mkdirSync(filename, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== uid || (Number(stat.mode) & 0o077) !== 0)
      throw new Error('Owner lease directory must be private, owned by the current user and not a symlink.');
  };
  const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
  let native, flock, fcntl, prctl;
  const load = () => {
    if (flock) return;
    if (!nativeSpec || nativeSpec.version !== '3.3.7' || !/^[a-f0-9]{64}$/.test(nativeSpec.sha256)
        || !path.isAbsolute(nativeSpec.path)) throw new Error('Pinned POSIX lease runtime is unavailable.');
    const fd = fs.openSync(nativeSpec.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd, { bigint: true }); regular(before);
      if (createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== nativeSpec.sha256)
        throw new Error('Pinned POSIX lease runtime integrity changed.');
      if (!sameInode(before, fs.lstatSync(nativeSpec.path, { bigint: true }))) throw new Error('Pinned POSIX lease runtime inode changed.');
      native = requireNative(nativeSpec.path);
      if (native.version !== '3.3.7' || !sameInode(before, fs.lstatSync(nativeSpec.path, { bigint: true })))
        throw new Error('Pinned POSIX lease runtime identity changed.');
      const muslArchitecture = { x64: 'x86_64', arm64: 'aarch64', arm: 'armhf', ia32: 'i386', riscv64: 'riscv64' }[process.arch];
      const candidates = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib']
        : ['libc.so.6', ...(muslArchitecture ? [`/lib/ld-musl-${muslArchitecture}.so.1`] : [])];
      let libc, loadError;
      for (const filename of candidates) {
        try { libc = native.load(filename); break; } catch (error) { loadError = error; }
      }
      if (!libc) throw new Error('The operating system flock provider is unavailable.', { cause: loadError });
      flock = libc.func('int flock(int fd, int operation)');
      fcntl = libc.func('int fcntl(int fd, int command, int argument)');
      if (process.platform === 'linux') prctl = libc.func('int prctl(int option, unsigned long arg2, unsigned long arg3, unsigned long arg4, unsigned long arg5)');
    } finally { fs.closeSync(fd); }
  };
  return Object.freeze({
    protectInheritedWorker(canonical, parentPid) {
      load();
      if (!Number.isInteger(parentPid) || parentPid < 2 || process.ppid !== parentPid)
        throw new Error('Original POSIX launcher parent exited before worker protection.');
      const fd = 4;
      const filename = path.join(path.dirname(canonical), '.rabi-agent-leases',
        createHash('sha256').update('launcher:' + canonical).digest('hex') + '.lock');
      const inherited = fs.fstatSync(fd, { bigint: true }); regular(inherited);
      if (!sameInode(inherited, fs.lstatSync(filename, { bigint: true })) || flock(fd, 2 | 4) !== 0)
        throw new Error('Worker did not inherit the original launcher lease.');
      // Retain this open-file-description until worker exit, but never leak it to tools.
      const flags = fcntl(fd, 1, 0); // F_GETFD
      if (flags < 0 || fcntl(fd, 2, flags | 1) !== 0) throw new Error('Could not fence inherited worker lease.'); // F_SETFD / FD_CLOEXEC
      // Linux kills even a blocked worker when its original launcher dies. Other
      // POSIX platforms keep the shared lease until their worker actually exits.
      if (prctl && prctl(1, 9, 0, 0, 0) !== 0) throw new Error('Could not establish original launcher parent-death protection.');
      if (process.ppid !== parentPid || !process.connected) throw new Error('Original POSIX launcher exited during worker protection.');
    },
    acquire(canonical, role) {
      if (!path.isAbsolute(canonical) || !['launcher', 'config'].includes(role)) throw new Error('Invalid owner lease identity.');
      load();
      const root = path.join(path.dirname(canonical), '.rabi-agent-leases'); directory(root);
      const hash = createHash('sha256').update(`${role}:${canonical}`).digest('hex');
      const filename = path.join(root, `${hash}.lock`);
      const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      let released = false, original;
      try {
        original = fs.fstatSync(fd, { bigint: true }); regular(original);
        if (flock(fd, 2 | 4) !== 0) {
          const errno = native.errno();
          const error = new Error('Rabi Agent ownership is busy; no writer or worker started.');
          error.code = [native.os.errno.EAGAIN, native.os.errno.EWOULDBLOCK].includes(errno)
            ? 'RABI_AGENT_LEASE_BUSY' : 'RABI_AGENT_LEASE_FAILED';
          error.errno = errno; throw error;
        }
        if (!sameInode(original, fs.lstatSync(filename, { bigint: true }))) throw new Error('Owner lease inode changed during acquisition.');
      } catch (error) { fs.closeSync(fd); throw error; }
      const handle = Object.freeze({ canonical, role, filename,
        inheritedDescriptor() { this.assertCurrent(); return fd; },
        assertCurrent() {
          if (released) throw new Error('The original owner lease was released.');
          const current = fs.fstatSync(fd, { bigint: true }); regular(current);
          if (!sameInode(original, current) || !sameInode(original, fs.lstatSync(filename, { bigint: true })))
            throw new Error('The original owner lease inode changed.');
        },
        release() {
          if (released) return;
          released = true; fs.closeSync(fd);
          // Never unlink: replacement of the stable inode would create a second lock domain.
        }
      });
      return handle;
    }
  });
}

function privateDirectory(filename) {
  try { fs.mkdirSync(filename, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(filename, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== process.getuid() || (Number(stat.mode) & 0o077) !== 0)
    throw new Error('POSIX native runtime directory is not private.');
}

/** Freeze the already installed, exact Koffi addon outside replaceable release selection. */
export function materializePosixLeaseNative(root, requireModule = createRequire(import.meta.url)) {
  if (!['linux', 'darwin'].includes(process.platform)) return undefined;
  privateDirectory(root);
  const koffi = requireModule('koffi');
  const api = koffi.default ?? koffi;
  if (api.version !== '3.3.7') throw new Error('POSIX owner leases require the installed Koffi 3.3.7 dependency.');
  const loaded = Object.entries(requireModule.cache).filter(([filename, module]) => filename.endsWith('.node')
    && module.exports === api && module.exports.version === '3.3.7');
  if (loaded.length !== 1) throw new Error('Cannot establish the exact installed POSIX lease addon.');
  const bytes = fs.readFileSync(fs.realpathSync(loaded[0][0]));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, '.rabi-agent-native'); privateDirectory(directory);
  const filename = path.join(directory, `koffi-3.3.7-${process.platform}-${process.arch}-${sha256}.node`);
  const verifyArtifact = () => {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || Number(stat.uid) !== process.getuid() || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o777) !== 0o600
          || createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== sha256)
        throw new Error('The content-addressed POSIX lease addon is not the original private artifact.');
      const current = fs.lstatSync(filename, { bigint: true });
      if (stat.dev !== current.dev || stat.ino !== current.ino) throw new Error('POSIX lease addon inode changed during verification.');
    } finally { fs.closeSync(fd); }
  };
  // A crash may leave a private staging file, never a truncated published addon.
  if (fs.existsSync(filename)) verifyArtifact();
  else {
    const temporary = filename + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (fs.existsSync(filename)) verifyArtifact();
      // Concurrent publishers can only publish these identical content-hashed
      // bytes. Existing verified files normally keep their original inode.
      else fs.renameSync(temporary, filename);
      verifyArtifact();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return Object.freeze({ path: filename, sha256, version: '3.3.7' });
}

export function posixOwnerLeaseRuntime(canonical) {
  const root = path.dirname(canonical);
  if (!runtimes.has(root)) runtimes.set(root, createPosixOwnerLeaseRuntime({ fs, path, createHash,
    requireNative: createRequire(import.meta.url), nativeSpec: materializePosixLeaseNative(root) }));
  return runtimes.get(root);
}

/** Compatibility rejection only; this marker is never an acquisition or liveness predicate. */
export function requirePosixOwnerProtocol(canonical) {
  if (process.platform === 'win32') return;
  const root = path.dirname(canonical), launcher = path.join(root, 'rabi-agent-launcher.mjs');
  const installed = fs.existsSync(path.join(root, 'current-release.json')) || fs.existsSync(launcher);
  if (installed && (!fs.existsSync(launcher) || !fs.readFileSync(launcher, 'utf8').includes('RABI_AGENT_POSIX_OWNER_PROTOCOL:2')))
    throw new Error('POSIX owner protocol upgrade requires the original controlled offline upgrade; legacy TCP owner cannot be adopted online. Existing launcher and pointer are unchanged.');
}

/** Discovery bytes alone never establish an owner; all commands still require a fresh HMAC nonce proof. */
export function readLauncherControlDiagnostic(filename, configHash) {
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const fd = fs.openSync(filename, flags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > 16_384n || (process.platform !== 'win32'
        && (Number(stat.uid) !== process.getuid() || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o777) !== 0o600)))
      throw new Error('Launcher control diagnostic is not the original private regular file.');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.configHash !== configHash || !/^[a-f0-9]{64}$/.test(value.token || '')) throw new Error('Launcher control identity is unavailable.');
    if (process.platform !== 'win32' && (value.protocol !== 2 || value.address?.host !== '127.0.0.1'
        || !Number.isInteger(value.address?.port) || value.address.port < 1 || value.address.port > 65535))
      throw new Error('Launcher control address is unavailable; no legacy TCP fallback was attempted.');
    return value;
  } finally { fs.closeSync(fd); }
}

/** Retain the original launcher OFD through worker exit; never use a diagnostic PID as a lease. */
export function protectPosixWorkerLease(configPath, parentPid) {
  if (process.platform === 'win32') return;
  const canonical = fs.realpathSync(configPath);
  posixOwnerLeaseRuntime(canonical).protectInheritedWorker(canonical, parentPid);
}

/** Old launchers cannot acknowledge this protocol on their original parent/child IPC. */
export async function requirePosixParentOwner(configPath, timeoutMs = 3_000) {
  if (process.platform === 'win32') return;
  if (!process.connected || typeof process.send !== 'function') throw new Error('POSIX connector requires its original v2 launcher owner.');
  const canonical = fs.realpathSync(configPath);
  const configHash = createHash('sha256').update(canonical).digest('hex');
  const nonce = (await import('node:crypto')).randomBytes(32).toString('hex');
  await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); process.off('message', reply); process.off('disconnect', lost); error ? reject(error) : resolve(); };
    const lost = () => finish(new Error('Original POSIX launcher IPC was lost before protocol verification.'));
    const reply = message => {
      if (message?.type !== 'posixOwnerProtocol' || message.nonce !== nonce) return;
      finish(message.protocol === 2 && message.configHash === configHash ? undefined
        : new Error('Original POSIX launcher owner protocol was rejected.'));
    };
    const timer = setTimeout(() => finish(new Error('Legacy POSIX launcher cannot adopt a v2 worker online; original launcher and pointer remain unchanged.')), timeoutMs);
    process.on('message', reply); process.once('disconnect', lost);
    process.send({ type: 'posixOwnerChallenge', nonce, configHash }, error => { if (error) finish(error); });
  });
}

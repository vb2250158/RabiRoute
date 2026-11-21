import { win32 } from 'node:path';

const titleCapacity = 513;
const pathCapacity = 32768;
let windowsApi;

async function loadWindowsApi() {
  const { default: koffi } = await import('koffi');
  const user = koffi.load('user32.dll');
  const kernel = koffi.load('kernel32.dll');
  return {
    address: koffi.address,
    foreground: user.func('__stdcall', 'GetForegroundWindow', 'void *', []),
    title: user.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']),
    processId: user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'void *']),
    open: kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
    image: kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int', ['void *', 'uint32', 'void *', 'void *']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']),
  };
}

function cleanLabel(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, ' ').trim();
}

function applicationName(api, window) {
  const processId = Buffer.alloc(4);
  api.processId(window, processId);
  const pid = processId.readUInt32LE();
  if (!pid) return '';
  const process = api.open(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!process) return '';
  try {
    const path = Buffer.alloc(pathCapacity * 2);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(pathCapacity);
    if (!api.image(process, 0, path, length)) return '';
    return cleanLabel(win32.basename(path.toString('utf16le', 0, length.readUInt32LE() * 2)));
  } finally {
    api.close(process);
  }
}

/** Read the current window at request time. The title is untrusted display data. */
export async function readForegroundWindow() {
  const api = await (windowsApi ??= loadWindowsApi());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const window = api.foreground();
    if (!window) break;
    const titleBuffer = Buffer.alloc(titleCapacity * 2);
    const count = api.title(window, titleBuffer, titleCapacity);
    const title = cleanLabel(titleBuffer.toString('utf16le', 0, count * 2));
    const application = applicationName(api, window);
    const latest = api.foreground();
    if (latest && api.address(latest) === api.address(window) && (title || application)) {
      return { available: true, title, application, observedAt: Date.now() };
    }
  }
  return { available: false, observedAt: Date.now() };
}

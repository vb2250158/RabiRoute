import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Discovery stays within the active Home; another installation requires an explicit setting. */
export async function resolveElectronExecutable(configured, home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const executable = configured || join(home, 'electron', 'electron.exe')
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) throw Error('DEVICE_ELECTRON_PATH_INVALID')
  let file
  try { file = await stat(executable) }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw Error('DEVICE_ELECTRON_NOT_FOUND')
    if (error.code === 'EACCES' || error.code === 'EPERM') throw Error('DEVICE_ELECTRON_UNREADABLE')
    throw Error('DEVICE_ELECTRON_UNAVAILABLE')
  }
  if (!file.isFile() || file.size === 0) throw Error('DEVICE_ELECTRON_PATH_INVALID')
  return executable
}

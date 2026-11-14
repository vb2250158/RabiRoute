import { spawnOwnedProcess, deviceEnvironment } from '../../src/windows-job.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const child = fileURLToPath(new URL('./job-child.mjs', import.meta.url));
const owner = spawnOwnedProcess({ executable: process.execPath, args: [child, process.argv[2]], cwd: dirname(child),
  env: deviceEnvironment(), startSuspended: process.argv[3] === 'suspended' });
process.stdout.write(JSON.stringify({ pid: owner.pid }) + '\n');
process.stdin.on('data', async buffer => {
  const action = buffer.toString().trim();
  if (action === 'dispose') { await owner.dispose(); process.exit(0); }
  if (action === 'exit') process.exit(0);
});
setInterval(() => {}, 1000);

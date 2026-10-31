import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPluginCandidate } from './lib/developer-verification.mjs';

export async function main(argv, signal) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Usage: node scripts/verify-plugin-candidate.mjs --config <local-config.json>');
  const configPath = path.resolve(argv[1]);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  for (const field of ['sourceRoot', 'candidateRoot', 'cacheRoot']) if (config[field]) config[field] = path.resolve(path.dirname(configPath), config[field]);
  const result = await verifyPluginCandidate({ ...config, signal });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = message => { if (message?.type === 'cancel-verification') controller.abort(); };
  const disconnected = () => controller.abort();
  process.on('message', cancel);
  process.on('disconnect', disconnected);
  if (process.connected) process.send?.({ type: 'verification-ready' });
  try { process.exitCode = await main(process.argv.slice(2), controller.signal); }
  finally {
    process.off('message', cancel);
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
}

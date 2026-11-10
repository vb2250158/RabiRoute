#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createManagerClient } from './lib/manager-client.mjs';
import { createHostEndpointSession } from './lib/host-endpoint.mjs';
import { runOperationCommand } from './lib/operation-cli.mjs';
import { OperationSdkError } from './lib/operation-sdk.mjs';

/** Local Host discovery and enrolled remote connections use the same operation SDK. */
export async function runCli(args, dependencies = {}) {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    return { ok: true, data: {
      commands: ['categories', 'list --category <id>', 'search <query> [--category <id>]',
        'describe <operation> [--view input|result|full]', 'call <operation> [--input-file <json> | --input-json <json> | --input-stdin]'],
      invocation: 'node apps/rabi-agent/rabi-cli.mjs <command>',
      remote: '--config <private-connection.json> --agent-type <type> --id <sessionId>',
      request: '--request-id <original-request> --idempotency-key <original-key> --if-match <revision>',
      output: '--output <new-file>; WebSocket uses --frames-stdin with JSONL frames.'
    } };
  }

  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const configPath = option('--config');
  let client = dependencies.client;
  let protectedCredential;
  if (!client && configPath) {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    protectedCredential = config.nodeCredential;
    client = createManagerClient({ config, configPath, agentType: option('--agent-type'), sessionId: option('--id') });
  } else if (!client) {
    const endpointSession = createHostEndpointSession({ hostExecutable: process.env.RABIROUTE_HOST_EXE });
    const endpoint = await endpointSession.ensure({ diagnostic: true });
    client = createManagerClient({ managerUrl: endpoint.managerUrl, endpointSession, localHost: true });
  }
  const redact = value => {
    if (!protectedCredential) return value;
    if (typeof value === 'string') return value.split(protectedCredential).join('[REDACTED]').split(encodeURIComponent(protectedCredential)).join('[REDACTED]');
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]));
    return value;
  };
  return redact(await runOperationCommand(args, client.operations, { ...dependencies, protectedCredential, redact }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runCli(process.argv.slice(2), { signal: controller.signal, inputStream: process.stdin, readInput: async () => {
      const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok || result.uncertain) process.exitCode = 1;
  } catch (error) {
    const result = error instanceof OperationSdkError
      ? { ok: false, statusCode: error.receipt?.statusCode, error: error.details ?? { message: error.message } }
      : { ok: false, error: { message: error.message } };
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

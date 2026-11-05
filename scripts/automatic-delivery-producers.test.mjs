import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run from scripts/ after a backend build, or from an external review fixture
// with cwd set to the candidate repository. No installed app or user data is read.
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasRepositorySource = root => fs.access(path.join(root, 'src/manager/controlPlaneRoutes.ts')).then(() => true, () => false);
const sourceRoot = await hasRepositorySource(scriptRoot) ? scriptRoot : process.cwd();
assert.ok(await hasRepositorySource(sourceRoot), 'Run this test from the repository root.');
const importBuilt = relative => import(pathToFileURL(path.join(sourceRoot, 'dist', relative)).href);
const { EndpointDeliveryRecovery, reconcileEndpointDelivery } = await importBuilt('agentRequests/endpointDelivery.js');
const { MessageProcessingAutomationService } = await importBuilt('manager/messageProcessingAutomationService.js');
const ts = (await import(pathToFileURL(path.join(sourceRoot, 'node_modules/typescript/lib/typescript.js')).href)).default;
const controlText = await fs.readFile(path.join(sourceRoot, 'src/manager/controlPlaneRoutes.ts'), 'utf8');
const controlAst = ts.createSourceFile('controlPlaneRoutes.ts', controlText, ts.ScriptTarget.Latest, true);
const tick = () => new Promise(resolve => setImmediate(resolve));

function findNode(predicate) {
  let result;
  const visit = node => {
    if (result) return;
    if (predicate(node)) { result = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(controlAst);
  assert.ok(result, 'The production entry point must exist.');
  return result;
}

function storm() {
  const endpoint = { kind: 'local', managerInstanceId: 'fixture-manager', agentId: 'local:codex', provider: 'codex', sessionId: 'fixture-target', authorizationIncarnation: 'fixture-authority' };
  const rows = Array.from({ length: 5402 }, (_, index) => ({
    deliveryId: `fixture-delivery-${index}`, state: index < 5400 ? 'dispatching' : 'prepared',
    target: endpoint, source: { ...endpoint, sessionId: 'fixture-source' }, generation: 'fixture-generation',
    prompt: 'Synthetic fixture only', preparation: { responsePolicy: 'none', target: { threadId: 'fixture-target' } }
  }));
  const byId = new Map(rows.map(row => [row.deliveryId, row]));
  const stats = { reads: 0, reconciles: 0, dispatches: 0, writes: 0, authorizations: 0 };
  const store = {
    ready: async () => {},
    listEndpointDeliveryMetadata: () => rows.map(({ prompt, ...row }) => row),
    readEndpointDelivery: async id => { stats.reads++; return byId.get(id); },
    getEndpointDelivery: id => byId.get(id), assertEndpointDeliveryActive: () => {},
    markEndpointDispatching: async () => { stats.writes++; return 'fixture-attempt'; },
    noteEndpointDeliveryFailure: async () => { stats.writes++; },
    commitEndpointReceipt: async () => { throw new Error('No receipt may commit in this unknown-receipt fixture.'); }
  };
  const options = {
    store, authorize: () => { stats.authorizations++; },
    reconcile: async () => { stats.reconciles++; return undefined; },
    dispatch: async () => { stats.dispatches++; throw new Error('Synthetic acknowledgement unavailable.'); }
  };
  return { rows, stats, store, options };
}

async function exerciseStartup(fixture) {
  const recovery = new EndpointDeliveryRecovery(fixture.options);
  const calls = { start: 0, event: 0, stop: 0, registrySubscriptions: 0 };
  const observed = Object.fromEntries(['start', 'onEvent', 'stop'].map(method => [method, (...args) => {
    calls[method === 'onEvent' ? 'event' : method]++;
    return recovery[method](...args);
  }]));
  let registryEvent, cleanup;
  const context = vm.createContext({
    agentEndpointDelivery: { recovery: observed },
    lanAgentRegistry: { onDeliveryRecoveryEvent: callback => { calls.registrySubscriptions++; registryEvent = callback; return () => {}; }, close: () => {} },
    managerRuntimeOwner: { register: (_id, callback) => { cleanup = callback; } },
    managerOperationalLog: { record: () => {} }, managerOperationalError: () => {}, rootDir: 'fixture-root',
    rabiLinkBusinessOwners: {}, instanceThreadTransport: {}
  });
  const start = controlText.indexOf('  const endpointRecovery = agentEndpointDelivery.recovery;');
  const end = controlText.indexOf('  managerRuntimeOwner.register("local_computer",', start);
  assert.ok(start >= 0 && end > start, 'Capture the production recovery registration and retirement block.');
  vm.runInContext(controlText.slice(start, end), context);
  registryEvent?.();
  const receiptProperty = findNode(node => ts.isPropertyAssignment(node) && node.name.getText(controlAst) === 'deliveryReceiptChanged');
  vm.runInContext(`(${receiptProperty.initializer.getText(controlAst)})()`, context);
  await tick();
  assert.equal(typeof cleanup, 'function');
  await cleanup();
  return calls;
}

test('startup, registry and receipt callbacks do not scan or dispatch 5400 unknown plus 2 prepared reservations', async () => {
  const fixture = storm();
  const calls = await exerciseStartup(fixture);
  assert.deepEqual(calls, { start: 0, event: 0, stop: 1, registrySubscriptions: 0 });
  assert.deepEqual(fixture.stats, { reads: 0, reconciles: 0, dispatches: 0, writes: 0, authorizations: 0 });
  assert.equal(fixture.rows.length, 5402);
});

test('the production Stop hook projects scoped pending IDs without ledger writes or delivery recovery', async () => {
  const fixture = storm(), calls = { recovery: 0, turn: 0, ready: 0, projection: 0 };
  const hook = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordAgentRequestStop');
  const compiled = ts.transpileModule(hook.getText(controlAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const context = vm.createContext({
    managerReadOnly: false,
    agentEndpointDelivery: { recovery: { onEvent: async () => { calls.recovery++; } } },
    agentRequests: {
      ready: async () => { calls.ready++; },
      unansweredTargetRequestIds: (sessionId, workspace) => {
        calls.projection++;
        assert.equal(sessionId, 'fixture-source');
        if (workspace) assert.equal(workspace, 'fixture-workspace');
        return workspace ? ['fixture-request-current'] : ['fixture-request-current', 'fixture-request-other-workspace'];
      },
      recordTargetTurnEnded: async () => { calls.turn++; throw new Error('Stop must not write the request ledger'); }
    },
    managerOperationalLog: { record: () => {} }, managerOperationalError: () => {}, rootDir: 'fixture-root'
  });
  vm.runInContext(`${compiled}\nglobalThis.runHook = recordAgentRequestStop;`, context);
  const result = await context.runHook({ sessionId: 'fixture-source', cwd: 'fixture-workspace', turnId: 'fixture-turn' });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'unanswered_agent_requests_at_stop');
  assert.deepEqual(Array.from(result.requestIds), ['fixture-request-current']);
  assert.deepEqual(Array.from(result.pendingSessionRequestIds), ['fixture-request-current', 'fixture-request-other-workspace']);
  assert.equal(result.snapshotComplete, true);
  assert.equal(result.turnId, 'fixture-turn');
  assert.deepEqual(calls, { recovery: 0, turn: 0, ready: 1, projection: 2 });
  assert.equal(fixture.stats.dispatches, 0);
});

test('explicit same-ID receipt-only reconciliation preserves unknown state without sending again', async () => {
  const fixture = storm();
  assert.equal(await reconcileEndpointDelivery('fixture-delivery-0', fixture.options, { receiptOnly: true }), false);
  assert.equal(fixture.stats.reads, 1); assert.equal(fixture.stats.reconciles, 1);
  assert.equal(fixture.stats.dispatches, 0); assert.equal(fixture.stats.writes, 0);
  assert.ok(fixture.stats.authorizations > 0);
  assert.equal(fixture.rows[0].state, 'dispatching');
});

test('an explicit receipt-only read of a prepared reservation does not initiate a send', async () => {
  const fixture = storm();
  assert.equal(await reconcileEndpointDelivery('fixture-delivery-5400', fixture.options, { receiptOnly: true }), false);
  assert.equal(fixture.stats.reads, 1); assert.equal(fixture.stats.reconciles, 0);
  assert.equal(fixture.stats.dispatches, 0); assert.equal(fixture.stats.writes, 0);
  assert.equal(fixture.rows[5400].state, 'prepared');
});

test('owner stop joins an already entered recovery batch without deleting its reservations', async () => {
  const fixture = storm(); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  fixture.options.reconcile = async () => { fixture.stats.reconciles++; enter(); await gate; return undefined; };
  const recovery = new EndpointDeliveryRecovery(fixture.options), event = recovery.onEvent();
  await entered;
  let stopped = false;
  const stopping = recovery.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  release(); await Promise.all([event, stopping]);
  assert.equal(stopped, true); assert.equal(fixture.stats.reconciles, 16);
  assert.equal(fixture.stats.dispatches, 0); assert.equal(fixture.rows.length, 5402);
});

async function exerciseProfilePlugin() {
  const profile = JSON.parse(await fs.readFile(path.join(sourceRoot, 'plugins/profiles/desktop.json'), 'utf8'));
  const selected = profile.instances.find(instance => instance.package === 'io.rabiroute.manager.message-processing-automation');
  assert.ok(selected?.enabled, 'The existing automation plugin remains enabled in the desktop profile.');
  const packageRoot = path.join(sourceRoot, 'plugins/builtin', selected.package, selected.version);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'rabi.plugin.json'), 'utf8'));
  assert.equal(manifest.id, selected.package); assert.equal(manifest.version, selected.version);
  const managerEntry = path.resolve(packageRoot, manifest.entries.manager.module);
  assert.ok(managerEntry.startsWith(packageRoot + path.sep), 'The manager entry remains inside its selected package.');
  const pluginText = await fs.readFile(managerEntry, 'utf8');
  const stats = { reminders: 0, knowledgeStarts: 0, knowledgeStops: 0, plans: 0 };
  const timers = new Map(); let timerSequence = 0, plan, publication;
  const requests = Array.from({ length: 413 }, (_, index) => ({ id: `fixture-request-${index}`, status: 'awaiting_response', nextReminderAt: '2000-01-01T00:00:00Z', reminderCount: index === 0 ? 413 : 1, updatedAt: '2000-01-01T00:00:00Z' }));
  class Automation extends MessageProcessingAutomationService {
    constructor(options) { super({ ...options, now: () => 1_700_000_000_000,
      scheduleTimer: callback => { const id = { id: ++timerSequence, unref() {} }; timers.set(id, () => { timers.delete(id); callback(); }); return id; },
      clearTimer: id => timers.delete(id) }); }
  }
  class Knowledge { async start() { stats.knowledgeStarts++; } async stop() { stats.knowledgeStops++; } }
  const runtime = {
    MessageProcessingAutomationService: Automation, KnowledgeCallbackReminderService: Knowledge,
    agentRequests: { ready: async () => {}, list: () => requests, get: id => requests.find(row => row.id === id) },
    messageProcessingBoard: { list: () => [], getRequirement: () => undefined, pendingKnowledgeMatches: () => [], recordKnowledgeReminder: () => {} },
    deliverAgentRequestReminder: async () => { stats.reminders++; }, deliverKnowledgeCallbackReminder: async () => {}, recordAgentRequestReminderFailure: () => {},
    managerOperationalLog: { record: () => {} }, managerOperationalError: () => {},
    handleMessageProcessingPlanUpdate: () => { stats.plans++; }, subscribePlanUpdates: callback => { plan = callback; return () => { plan = undefined; }; }
  };
  // Execute this package's real factory against synthetic host services. Only the
  // SDK definePlugin identity wrapper is substituted; no native transport exists.
  const context = vm.createContext({ definePlugin: value => value, Promise, Set, Error });
  vm.runInContext(pluginText.replace(/^import .*?;\s*/, '').replace('export const activate =', 'globalThis.activate ='), context);
  context.activate({ identity: { instanceId: 'fixture-plugin' }, services: { require: () => runtime, provide: () => {} },
    effects: { add: () => {} }, publication: { add: value => { publication = value; } }, lifecycle: { fail: error => { throw error; } } });
  publication.publish();
  publication.afterPublish({ previousRetirement: Promise.resolve(), signal: new AbortController().signal });
  await tick(); await tick();
  const timersAtStart = timers.size;
  runtime.messageProcessingAutomationService.schedule(requests[0]);
  runtime.messageProcessingAutomationService.refresh();
  plan?.({ roleDir: 'fixture-role', after: {} });
  await tick();
  const timersAfterHookAndRefresh = timers.size;
  await publication.retire();
  return { ...stats, timersAtStart, timersAfterHookAndRefresh, timersAfterRetire: timers.size };
}

test('profile-selected plugin never wakes historical reply requests on activation or later schedule/refresh', async () => {
  const result = await exerciseProfilePlugin();
  assert.equal(result.timersAtStart, 0); assert.equal(result.timersAfterHookAndRefresh, 0);
  assert.equal(result.reminders, 0); assert.equal(result.timersAfterRetire, 0);
});

test('profile-selected plugin retains knowledge reminders and plan subscriptions after clean reactivation', async () => {
  for (let activation = 0; activation < 2; activation++) {
    const result = await exerciseProfilePlugin();
    assert.equal(result.knowledgeStarts, 1); assert.equal(result.knowledgeStops, 1); assert.equal(result.plans, 1);
    assert.equal(result.reminders, 0); assert.equal(result.timersAtStart, 0);
  }
});

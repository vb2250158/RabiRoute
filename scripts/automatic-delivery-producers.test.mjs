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
const { KnowledgeCallbackReminderService } = await importBuilt('plugins/io.rabiroute.manager.message-processing-automation/src/manager/knowledgeCallbackReminderService.js');
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
  assert.doesNotMatch(controlText, /\bdeliveryReceiptChanged\b/, 'The retired receipt-scan callback has no compatibility shell.');
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
  const fixture = storm(), calls = { recovery: 0, ready: 0, projection: 0 };
  const hook = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordAgentRequestStop');
  const compiled = ts.transpileModule(hook.getText(controlAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const context = vm.createContext({
    managerReadOnly: false,
    agentEndpointDelivery: { recovery: { onEvent: async () => { calls.recovery++; } } },
    agentRequests: {
      ready: async () => { calls.ready++; },
      unansweredTargetRequestSnapshot: (sessionId, workspace) => {
        calls.projection++;
        assert.equal(sessionId, 'fixture-source');
        if (workspace) assert.equal(workspace, 'fixture-workspace');
        return { requestIds: workspace ? ['fixture-request-current'] : ['fixture-request-current', 'fixture-request-other-workspace'], complete: true };
      }
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
  assert.deepEqual(calls, { recovery: 0, ready: 1, projection: 2 });
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
  const packageRoot = path.join(sourceRoot, 'src/plugins', selected.package);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'rabi.plugin.json'), 'utf8'));
  assert.equal(manifest.id, selected.package); assert.equal(manifest.version, selected.version);
  const managerEntry = path.resolve(packageRoot, manifest.entries.manager.module);
  assert.ok(managerEntry.startsWith(packageRoot + path.sep));
  const pluginText = await fs.readFile(managerEntry, 'utf8');
  const factoryText = await fs.readFile(path.join(packageRoot, 'hostRuntime.mjs'), 'utf8');
  assert.doesNotMatch(pluginText + factoryText, /MessageProcessingAutomationService|deliverAgentRequestReminder|messageProcessingAutomationService/);
  const stats = { knowledgeStarts: 0, knowledgeStops: 0, plans: 0, historicalReads: 0 };
  const timers = new Map(); let sequence = 0, plan, publication;
  const historical = Array.from({ length: 413 }, (_, index) => ({ id: `fixture-request-${index}`, status: 'awaiting_response',
    nextReminderAt: '2000-01-01T00:00:00Z', reminderCount: index === 0 ? 413 : 1, unknownField: { keep: index } }));
  const before = JSON.stringify(historical);
  class Knowledge extends KnowledgeCallbackReminderService {
    constructor(options) { super({ ...options,
      scheduleTimer: callback => { const timer = { id: ++sequence, unref() {} }; timers.set(timer, callback); return timer; },
      clearTimer: timer => timers.delete(timer) }); }
    async start() { stats.knowledgeStarts++; await super.start(); }
    async stop() { stats.knowledgeStops++; await super.stop(); }
  }
  const ports = {
    prepareModules: async () => {}, managerReadOnly: false,
    get agentRequests() { stats.historicalReads++; throw new Error('Activation must not open historical reply requests.'); },
    messageProcessingBoard: { list: () => [], getRequirement: () => undefined, pendingKnowledgeMatches: () => [], recordKnowledgeReminder: () => {} },
    deliverKnowledgeCallbackReminder: async () => {}, managerOperationalLog: { record: () => {} }, managerOperationalError: () => {},
    handleMessageProcessingPlanUpdate: () => { stats.plans++; }, subscribePlanUpdates: callback => { plan = callback; return () => { plan = undefined; }; }
  };
  // Execute both canonical owner factory and activation. Substitute only generated
  // bundle glue and the SDK identity wrapper; the real knowledge service is used.
  const context = vm.createContext({ definePlugin: value => value, KnowledgeCallbackReminderService: Knowledge,
    hostModules: [], Promise, Set, Error,
    createImplementation: () => ({ createOwnedRuntime: value => context.createOwnedRuntime(value) }) });
  vm.runInContext(factoryText.replace(/^import .*?;\s*/gm, '').replace('export function createOwnedRuntime', 'globalThis.createOwnedRuntime = function'), context);
  vm.runInContext(pluginText.replace(/^import .*?;\s*/gm, '').replace('export const activate =', 'globalThis.activate ='), context);
  await context.activate({ identity: { instanceId: 'fixture-plugin' }, services: { require: () => ports, provide: () => {} },
    effects: { add: () => {} }, publication: { add: value => { publication = value; } }, lifecycle: { fail: error => { throw error; } } });
  publication.publish();
  publication.afterPublish({ previousRetirement: Promise.resolve(), signal: new AbortController().signal });
  await tick(); await tick();
  const timersAtStart = timers.size;
  assert.equal('messageProcessingAutomationService' in ports, false, 'The retired service is absent, rather than a dormant schedule/refresh shell.');
  plan?.({ roleDir: 'fixture-role', after: {} }); await tick();
  const timersAfterPlan = timers.size;
  await publication.retire();
  assert.equal(JSON.stringify(historical), before, 'Unknown historical raw fields and original IDs are preserved.');
  assert.equal(ports.knowledgeCallbackReminderService, undefined);
  return { ...stats, timersAtStart, timersAfterPlan, timersAfterRetire: timers.size };
}

test('profile-selected plugin never opens historical reply requests on activation or plan update', async () => {
  const result = await exerciseProfilePlugin();
  assert.equal(result.timersAtStart, 0); assert.equal(result.timersAfterPlan, 0);
  assert.equal(result.historicalReads, 0); assert.equal(result.timersAfterRetire, 0);
});

test('profile-selected plugin retains knowledge reminders and plan subscriptions after clean reactivation', async () => {
  for (let activation = 0; activation < 2; activation++) {
    const result = await exerciseProfilePlugin();
    assert.equal(result.knowledgeStarts, 1); assert.equal(result.knowledgeStops, 1); assert.equal(result.plans, 1);
    assert.equal(result.historicalReads, 0); assert.equal(result.timersAtStart, 0);
  }
});

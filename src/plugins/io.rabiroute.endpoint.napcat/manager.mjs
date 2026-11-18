import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";

export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@4");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  const groupForward = egress.createNapcatGroupForward(host.manager.readRoute);
  await host.prepareModules(hostModules);
  const implementation = createImplementation(host);
  const owner = implementation.createNapcatManagerOwner(host.manager, host.managers.current("napcat"), context.lifecycle.signal);
  context.services.provide("endpoint.napcat@1", Object.freeze({ type: "napcat", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-napcat-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "NapCat / OneBot"
    },
    "endpointType": "napcat",
    "catalog": {
      "title": "NapCat / OneBot",
      "note": "连接 QQ 群聊和私聊",
      "icon": "mdi-qqchat",
      "group": {
        "id": "chat",
        "title": "聊天平台",
        "note": "连接群聊、私聊和协作平台",
        "order": 10
      },
      "order": 10
    },
    "rendererId": "endpoint.napcat.card.v1",
    "schemaId": "endpoint.napcat.route.v1",
    "readCommandId": "endpoint.napcat.route.read",
    "writeCommandId": "endpoint.napcat.route.write",
    "icon": "mdi-qqchat",
    "slot": "napcat",
    "hosts": [
      "web"
    ],
    "order": 10
  }
});
  ownMessageEndpointScan(context, { type: "napcat", label: "NapCat / OneBot", maturity: "verified", scan: owner.scan });
  let accepting = false, started = false, startupAttempted = false, published = false;
  let registration, retirement, reactive, managementContext;
  const flights = new Set();
  const assertAccepting = () => { if (!accepting) throw new Error("NapCat endpoint is not accepting actions."); };
  const controlContext = owner.context(assertAccepting);
  const run = action => {
    const operation = Promise.resolve().then(() => { assertAccepting(); return action(); });
    flights.add(operation);
    void operation.then(() => flights.delete(operation), () => flights.delete(operation));
    return operation;
  };
  const nativeEgressContext = {
    route: host.manager.readRoute, local: host.manager.requestIsLoopback,
    resolveNativeDirectory: (binding, signal, authorize) => implementation.resolveNapcatWebuiNativeDirectory({ ...managementContext,
      openManagementSession: (selection, requestSignal) => implementation.openNapcatWebuiManagementSession(owner.context(selection.assertCurrent), selection, requestSignal)
    }, binding, signal, authorize)
  };
  const nativeProducers = implementation.createNapcatNativeEgressProducers(nativeEgressContext);
  const quickReply = implementation.createNapcatQuickReplyProducer(nativeEgressContext);
  const publicEgress = Object.fromEntries(["readReplySource", "getLoginInfo", "sendGroupMessage", "sendPrivateMessage",
    "uploadGroupFile", "uploadPrivateFile", "readNapCatGroupFiles", "napcatStickerMessage"].map(name => [name, egress[name]]));
  ownMessageEndpointEgress(context, { type: "napcat", operations: {
    ...publicEgress, sendGroupForwardVariant: groupForward.sendGroupForwardVariant,
    ...Object.fromEntries(nativeProducers.map(producer => [producer.variant.operation, producer.send])),
    [quickReply.variant.operation]: quickReply.send
  }, sendVariants: [groupForward.variant, ...nativeProducers.map(producer => producer.variant), quickReply.variant],
    async dispose() {
      await dispose();
      if (published && host.managers.current("napcat")?.resources !== owner.resources) await owner.stopResources();
    } });
  const supervisor = new implementation.NapcatSupervisorService({
    restartDelayMs: 30000,
    async run(signal) {
      if (!startupAttempted) {
        startupAttempted = true;
        try { await implementation.autoLoginNapcatInstancesOnRabiStart(controlContext, undefined, signal); }
        catch (error) { console.warn("NapCat startup login failed; guardian continues", error); }
      }
      if (!signal.aborted) await implementation.runNapcatGuardianLoop(implementation.napcatGuardianDepsFor(controlContext, {
        listInstances: () => implementation.napcatGuardianInstances(controlContext),
        observe: request => implementation.observeNapcatGuardianInstance(controlContext, request),
        relaunch: request => implementation.relaunchNapcatGuardianInstance(controlContext, request)
      }), signal);
    },
    onError: error => console.warn("NapCat endpoint supervisor failed", error)
  });
  const ready = () => {
    if (accepting && started && host.manager.shouldAutostart && !host.manager.readOnly && host.manager.ready)
      void supervisor.start().catch(error => context.lifecycle.fail(error));
  };
  const hook = host.managers.prepare("napcat", {
    resources: owner.resources,
    configurationKey: owner.configurationKey,
    validateRoutes: owner.validateRoutes,
    reconcileRoutes: routes => started ? owner.reconcileRoutes(routes) : Promise.resolve(),
    inspect: owner.scanHealth, ready
  }, error => context.lifecycle.fail(error));
  const dispose = () => retirement ??= (async () => {
    accepting = false;
    hook.dispose();
    const retired = registration?.dispose();
    const results = await Promise.allSettled([supervisor.stop(), retired, reactive?.dispose(), ...flights]);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "NapCat endpoint retirement failed.");
  })();
  context.effects.adopt(dispose, "release exact NapCat endpoint resources");
  context.effects.add(async () => {
    const operations = implementation.createNapcatControlOperations({
      assertCurrent: assertAccepting,
      repairAll: () => run(owner.repair),
      add: body => run(() => owner.add(body, controlContext)),
      remove: body => run(() => owner.remove(body)),
      ensureReady: body => run(() => implementation.ensureNapcatInstanceReady(controlContext, body)),
      health: body => run(() => implementation.testNapcatHealth(controlContext, body)),
      loginPanel: body => run(() => implementation.readNapcatLoginPanel(controlContext, body)),
      loginAction: body => run(() => implementation.runNapcatLoginAction(controlContext, body)),
      configureOneBot: body => run(() => implementation.configureNapcatOneBot(controlContext, body)),
      launch: body => run(() => implementation.launchNapcatInstance(controlContext, body)),
      restart: body => run(() => implementation.restartNapcatInstance(controlContext, body))
    });
    const qq = { local: host.manager.requestIsLoopback, route: host.manager.readRoute, json: host.manager.jsonResponse };
    const qqOperations = [
      implementation.createAgentQqDiagnosticsOperation({ route: host.manager.readRoute, readStatus: host.manager.readGatewayStatus,
        routeRunning: host.manager.routeRunning, routeStartedAt: host.manager.routeStartedAt, jsonResponse: host.manager.jsonResponse }),
      implementation.createAgentGroupFilesOperation({ route: host.manager.readRoute, jsonResponse: host.manager.jsonResponse }),
      ...implementation.createQqMessageOperations(qq), ...implementation.createQqStickerOperations(qq)
    ];
    const apiContext = {
      rootDir: host.manager.rootDir,
      readOnly: () => host.manager.readOnly,
      local: host.manager.requestIsLoopback,
      route: host.manager.readRoute,
      assertCurrent: assertAccepting
    };
    managementContext = {
      ...apiContext,
      resourceObjects: host.manager.resourceObjects,
      protectedResourceObjects: host.manager.protectedResourceObjects,
      route: host.manager.readRoute,
      acquireNativeFileLease() {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        flights.add(held);
        let active = true;
        return { assertCurrent() { if (!active) throw new Error("Native directory lease is released."); },
          release() { if (active) { active = false; flights.delete(held); release(); } } };
      },
      prepareWebuiToken: (selection, operationId) => implementation.prepareNapcatWebuiTokenCommit({
        assertCurrent: assertAccepting,
        readRoutes: host.manager.readRoutes,
        routeVersion: host.manager.routeVersion,
        writeRoute: host.manager.writeRoute,
        resolveRouteMutation: host.manager.resolveRouteMutation,
        syncRoutes: host.manager.syncRoutes,
        inspectSource: (binding, token) => implementation.verifyNapcatWebuiTokenCommitSource(controlContext, binding, token)
      }, selection, operationId),
      openManagementSession: (selection, signal) => implementation.openNapcatWebuiManagementSession(controlContext, selection, signal)
    };
    const manifest = implementation.readNapcatApiManifest();
    const sourceFileOperations = implementation.createSourceFileOperations(apiContext);
    const artifactOperations = implementation.createNapcatArtifactOperations({
      ...apiContext,
      resourceObjects: host.manager.resourceObjects,
      protectedResourceObjects: host.manager.protectedResourceObjects
    });
    const egressContext = { ...apiContext, submitAgentSendVariant: host.manager.submitAgentSendVariant };
    const nativeContext = { ...apiContext, resolveQuickRequest: (selection, eventRef, signal) =>
      implementation.readNapcatQuickRequestContext(host.manager.protectedResourceObjects, selection, eventRef, selection.assertCurrent, signal) };
    const nativeOperations = implementation.createNapcatApiOperations(nativeContext, implementation.createNapcatApiDescriptors(manifest));
    const nativeByAction = new Map(nativeOperations.map(operation => [operation.contract.operationId, operation]));
    const specific = [
      ...sourceFileOperations, ...artifactOperations,
      ...implementation.createNapcatDownloadStreamOperations(apiContext),
      ...implementation.createNapcatNativeEgressOperations(egressContext),
      ...implementation.createNapcatFileResourceOperations({ ...apiContext, resourceObjects: host.manager.resourceObjects,
        protectedResourceObjects: host.manager.protectedResourceObjects, withManagedAttachment: host.manager.withManagedAttachment }),
      implementation.createNapcatEmojiLikesOperation(apiContext), implementation.createNapcatShareLinkOperation(apiContext),
      implementation.createNapcatTestStreamOperation(apiContext),
      implementation.createNapcatStopOperation({ ...apiContext,
        stopOwnedNapcat: (request, authorize) => implementation.stopNapcatInstance(owner.context(authorize), request) }),
      implementation.createNapcatQuickOperation({ ...egressContext, protectedResourceObjects: host.manager.protectedResourceObjects,
        invokeNativeAction: (action, input) => {
          const operation = nativeByAction.get(`agent.qq.onebot.${action}`);
          if (!operation) throw new Error("Original native action is unavailable.");
          return operation.handler(input);
        } })
    ];
    const specificNames = new Set(specific.flatMap(operation => [operation.contract.operationId, ...(operation.contract.aliases ?? [])]));
    reactive = implementation.createNapcatWebuiReactiveOwner(managementContext);
    const protocolOperations = [
      ...nativeOperations.filter(operation => ![operation.contract.operationId, ...(operation.contract.aliases ?? [])].some(name => specificNames.has(name))), ...specific,
      implementation.createNapcatApiReceiptOperation(apiContext), implementation.createNapcatApiEventCatalogOperation(manifest),
      ...implementation.createNapcatWebuiManagementOperations(managementContext),
      implementation.createNapcatWebuiManagementReceiptOperation(managementContext),
      ...implementation.createNapcatWebuiExtendedOperations(managementContext),
      ...implementation.createNapcatWebuiFileOperations(managementContext),
      ...implementation.createNapcatWebuiAuthOperations(managementContext), ...reactive.operations,
      ...implementation.createNapcatWebuiApiOperations({ ...apiContext,
        openWebuiSession: (selection, signal) => implementation.openNapcatWebuiApiSession(controlContext, selection, signal) })
    ];
    registration = await host.operations.registerOperationsAsync(context.identity.instanceId, [...operations, ...qqOperations, ...protocolOperations], context.lifecycle.signal);
    return dispose;
  }, "prepare NapCat endpoint API operations");
  context.publication.add({
    ...hook.publication,
    publish() { hook.publication.publish(); published = true; },
    rollback() { published = false; hook.publication.rollback(); },
    async afterPublish({ previousRetirement, signal }) {
      await previousRetirement;
      signal.throwIfAborted();
      await owner.reconcileRoutes(host.manager.readRoutes());
      signal.throwIfAborted();
      started = true; accepting = true; ready();
    },
    retire: dispose
  }, "publish NapCat manager owner");
} }).activate;

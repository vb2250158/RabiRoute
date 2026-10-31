import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.rabilink-relay@1");
        context.services.provide("manager.rabilink-relay@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const pendingEffects = [];
            const disposers = [];
            const disposeStartedEffects = async () => {
                let firstError;
                for (const dispose of [...disposers].reverse()) {
                    try { await dispose(); } catch (error) { firstError ??= error; }
                }
                if (firstError) throw firstError;
            };
            const ctx = Object.freeze({
                effect(starter, label) {
                    const pending = Promise.resolve().then(starter).then(dispose => {
                        if (typeof dispose !== "function") throw new Error(`Plugin effect did not return a disposer: ${label ?? "effect"}.`);
                        disposers.push(dispose);
                        return dispose;
                    });
                    pendingEffects.push(pending);
                    return pending;
                }
            });
            try {
        let stopped = false, published = false, previousSync;
        const synchronizations = new Set();
        const sync = () => {
            if (stopped || runtime.syncActiveRabiLinkRelay !== sync) return Promise.resolve();
            const work = Promise.resolve().then(() => {
                if (!stopped && runtime.syncActiveRabiLinkRelay === sync)
                    return runtime.syncRabiLinkRelayRuntime(sync);
            });
            synchronizations.add(work);
            void work.then(() => synchronizations.delete(work), () => synchronizations.delete(work));
            return work;
        };
        let video, peer;
        let peerUpgrades, peerHttp, peerControls, videoOperations, profileOperations, mobileOperations, deviceAgentOperations;
        const preparations = new Set();
        const assertPreparing = () => {
            context.lifecycle.signal.throwIfAborted();
            if (stopped) throw new Error("RabiLink Relay preparation is retiring.");
        };
        const prepare = operation => {
            assertPreparing();
            const completion = Promise.resolve().then(() => { assertPreparing(); return operation(); });
            preparations.add(completion);
            void completion.then(() => preparations.delete(completion), () => preparations.delete(completion));
            return completion;
        };
        let stopping;
        const stopOwner = () => stopping ??= (async () => {
            stopped = true;
            // Factories and registration can finish after cancellation. Their
            // callbacks assign ownership before settling this join barrier.
            await Promise.allSettled([...preparations]);
            const ownsSharedRuntime = runtime.syncActiveRabiLinkRelay === sync;
            if (ownsSharedRuntime) runtime.syncActiveRabiLinkRelay = async () => {};
            peerUpgrades?.stopAccepting();
            peer?.stopAccepting();
            const results = await Promise.allSettled([
                ...[deviceAgentOperations, profileOperations, mobileOperations, videoOperations, peerControls, peerHttp, peerUpgrades]
                    .filter(Boolean).map(registration => Promise.resolve().then(() => registration.dispose())),
                Promise.resolve().then(() => video?.stop()),
                ...synchronizations,
                ...(ownsSharedRuntime ? [
                    Promise.resolve().then(() => runtime.peerLanServer.stop()),
                    Promise.resolve().then(() => runtime.rabiLinkRelayRuntime.stop())
                ] : [])
            ]);
            const native = await Promise.allSettled([Promise.resolve().then(() => peer?.stop())]);
            const failure = [...results, ...native].find(result => result.status === "rejected");
            if (failure) throw failure.reason;
        })();
        context.effects.adopt(stopOwner, "prepared Manager RabiLink Relay owner");
        await ctx.effect(() => stopOwner, "stop Manager RabiLink Relay plugin");
        assertPreparing();
        video = runtime.createDirectVideoReceiver();
        await prepare(async () => { peer = await runtime.createPeerRuntime(); });
        await prepare(async () => { videoOperations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createDirectVideoOperations(video), context.lifecycle.signal); });
        await prepare(async () => { profileOperations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createRabiLinkAgentDeviceOperations(), context.lifecycle.signal); });
        await prepare(async () => { mobileOperations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createRabiLinkMobileOperations(), context.lifecycle.signal); });
        await prepare(async () => { deviceAgentOperations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createDeviceAgentOperations(), context.lifecycle.signal); });
        assertPreparing();
        peerUpgrades = runtime.managerPluginRoutes.registerUpgrades(context.identity.instanceId, [peer.upgradeOperation]);
        peerHttp = runtime.managerPluginRoutes.registerHttpProxies(context.identity.instanceId, peer.httpOperations);
        await prepare(async () => { peerControls = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, peer.operations, context.lifecycle.signal); });
        assertPreparing();
        context.publication.add({
            publish() {
                previousSync = runtime.syncActiveRabiLinkRelay;
                // Mark the attempt before calling the pointer owner so rollback
                // can undo a publish callback that throws after its first write.
                published = true;
                peer.publish();
                runtime.syncActiveRabiLinkRelay = sync;
            },
            rollback() {
                if (!published) return;
                if (runtime.syncActiveRabiLinkRelay === sync) runtime.syncActiveRabiLinkRelay = previousSync;
                peer.rollback();
                published = false;
            },
            async afterPublish({ signal, previousRetirement }) {
                await previousRetirement;
                signal.throwIfAborted();
                peer.start();
                if (runtime.managerListenerReady) await sync();
            }
        }, "publish Manager RabiLink Relay owner");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.rabilink-relay");
    }
}).activate;

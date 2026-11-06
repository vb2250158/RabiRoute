/** Registrations belong to one activation; shared resources belong to the service package. */
export function createSpeechPluginLifecycle(runtime, identity, lifecycleSignal) {
    const owner = new runtime.SpeechApiOwner(runtime.speechApiContext);
    const registrations = [];
    let prepared = false, published = false, retiring;
    const retire = () => retiring ??= (async () => {
        const drain = (async () => {
            const results = await Promise.allSettled([
                ...registrations.map(registration => Promise.resolve().then(() => registration.dispose())),
                Promise.resolve().then(() => owner.events.stop())
            ]);
            const failure = results.find(result => result.status === "rejected");
            if (failure) throw failure.reason;
        })();
        runtime.resources.drains.add(drain);
        const results = await Promise.allSettled([drain]);
        runtime.resources.drains.delete(drain);
        if (published && !runtime.replacementOwnsResources()) {
            results.push(...await Promise.allSettled([runtime.stopResources()]));
        }
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
    })();
    return Object.freeze({
        instanceId: identity.instanceId,
        get retired() { return retiring; },
        async prepare() {
            if (retiring) throw new Error("Speech activation is already retiring.");
            const definitions = runtime.createSpeechApiOperations(owner);
            try {
                registrations.push(await runtime.managerPluginRoutes.registerOperationsAsync(identity.instanceId, definitions.operations, lifecycleSignal));
                registrations.push(runtime.managerPluginRoutes.registerHttpProxies(identity.instanceId, definitions.proxies));
                prepared = true;
                return retire;
            } catch (error) { await retire().catch(() => {}); throw error; }
        },
        publication: Object.freeze({
            publish() { if (!prepared || retiring) throw new Error("Speech activation must be prepared before publication."); published = true; },
            rollback() { published = false; },
            async afterPublish({ previousRetirement, signal }) {
                await previousRetirement;
                if (signal.aborted) return;
                if (runtime.isCurrent()) {
                    runtime.markReady();
                    if (runtime.managerServicesReady && !runtime.managerReadOnly) runtime.reconcile("speech plugin activation");
                }
            },
            retire
        })
    });
}

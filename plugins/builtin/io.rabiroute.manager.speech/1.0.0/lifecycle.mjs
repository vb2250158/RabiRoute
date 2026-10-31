/** Candidate effects own registrations; only the published activation owns shared speech shutdown. */
export function createSpeechPluginLifecycle(runtime, identity, lifecycleSignal) {
    const owner = new runtime.SpeechApiOwner(runtime.speechApiContext);
    const registrations = [];
    let prepared = false;
    let published = false;
    let previousReconcile;
    let retiring;
    const ownsRuntime = () => published && !retiring && runtime.reconcileActiveSpeech === reconcile;
    const reconcile = () => {
        if (!ownsRuntime()) return;
        return runtime.reconcileSpeechMicrophone(runtime.managerServicesReady ? "speech plugin activation" : "manager startup", ownsRuntime);
    };
    // A timed-out kernel disposal may still be joining native work. A later candidate
    // must join that original shutdown before publishing another shared-runtime owner.
    Object.defineProperty(reconcile, "retired", { get: () => retiring });

    const retire = () => retiring ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
            ...registrations.map(registration => Promise.resolve().then(() => registration.dispose())),
            Promise.resolve().then(() => owner.events.stop())
        ]);
        if (published && runtime.reconcileActiveSpeech === reconcile) {
            // A rejected kernel deadline does not end the original native work.
            // If startup fails on that barrier, shutdown still joins its real owner.
            if (previousReconcile?.retired) results.push(...await Promise.allSettled([previousReconcile.retired]));
            previousReconcile = undefined;
        }
        if (published && runtime.reconcileActiveSpeech === reconcile) {
            // Replacement publishes its pointer before old registrations drain. Recheck
            // after that drain so old requests and disconnects cannot stop the new owner.
            results.push(...await Promise.allSettled([
                // The process owner releases microphone and playback with the runtime.
                // Parallel HTTP stops race that shutdown and fail when optional speech
                // never started; the runtime owner's real stop remains authoritative.
                Promise.resolve().then(() => runtime.speechRuntimeControl.stop())
            ]));
            results.push(...await Promise.allSettled([
                Promise.resolve().then(() => runtime.speechModelManager.stop())
            ]));
        }
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
    });

    return Object.freeze({
        instanceId: identity.instanceId,
        async prepare() {
            // Rejection preserves the cleanup failure instead of restarting models over it.
            await runtime.reconcileActiveSpeech?.retired;
            if (retiring) throw new Error("Speech activation is already retiring.");
            const definitions = runtime.createSpeechApiOperations(owner);
            try {
                registrations.push(await runtime.managerPluginRoutes.registerOperationsAsync(identity.instanceId, definitions.operations, lifecycleSignal));
                registrations.push(runtime.managerPluginRoutes.registerHttpProxies(identity.instanceId, definitions.proxies));
                prepared = true;
                return retire;
            } catch (error) {
                await retire().catch(() => {});
                throw error;
            }
        },
        publication: Object.freeze({
            publish() {
                if (!prepared || retiring) throw new Error("Speech activation must be prepared before publication.");
                previousReconcile = runtime.reconcileActiveSpeech;
                published = true;
                runtime.reconcileActiveSpeech = reconcile;
            },
            rollback() {
                if (runtime.reconcileActiveSpeech === reconcile) runtime.reconcileActiveSpeech = previousReconcile;
                published = false;
                previousReconcile = undefined;
            },
            async afterPublish({ previousRetirement, signal }) {
                await previousRetirement;
                // Successful retirement releases the previous revision's closures.
                previousReconcile = undefined;
                if (signal.aborted) return;
                if (ownsRuntime() && runtime.managerServicesReady && !runtime.managerReadOnly) reconcile();
            },
            retire
        })
    });
}

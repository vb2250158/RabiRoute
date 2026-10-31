import { definePlugin } from "@rabiroute/plugin-sdk";

function incompatibleScheduler(source) {
    return Object.assign(new Error(`Memory scheduler ${source} lacks activation lifecycle state; a Host-controlled application switch is required.`), {
        code: "memory_scheduler_activation_requires_switch"
    });
}

export const activate = definePlugin({
    activate(context) {
        const runtime = context.services.require("host.manager.memory-consolidation@1");
        context.services.provide("manager.memory-consolidation@1", Object.freeze({ instanceId: context.identity.instanceId }));
        if (runtime.managerReadOnly) return;

        const scheduler = runtime.createMemoryConsolidationScheduler();
        if (["deferActivation", "activate", "isStarted"].some(method => typeof scheduler[method] !== "function")) {
            throw incompatibleScheduler("factory");
        }
        scheduler.deferActivation();
        let previous;
        let resumeStarted = false;
        let processOwnerAcquired = false;
        let retiring;
        const retire = () => retiring ??= Promise.resolve().then(async () => {
            if (runtime.memoryConsolidationScheduler === scheduler) runtime.memoryConsolidationScheduler = undefined;
            // Cancel scheduler admission first. The fixed native process owner may
            // be reused only after complete retirement, never by a candidate.
            const results = await Promise.allSettled([
                Promise.resolve().then(() => scheduler.stop()),
                Promise.resolve().then(() => processOwnerAcquired
                    ? runtime.manualTriggerProcesses.stopOwner("manager:memory-consolidation") : undefined)
            ]);
            previous = undefined;
            const failure = results.find(result => result.status === "rejected");
            if (failure) throw failure.reason;
        });
        context.effects.add(() => retire, "prepare Manager memory consolidation scheduler");
        context.publication.add({
            publish() {
                previous = runtime.memoryConsolidationScheduler;
                if (previous && typeof previous.isStarted !== "function") throw incompatibleScheduler("predecessor");
                resumeStarted = Boolean(previous?.isStarted());
                runtime.memoryConsolidationScheduler = scheduler;
            },
            rollback() {
                if (runtime.memoryConsolidationScheduler === scheduler) runtime.memoryConsolidationScheduler = previous;
                previous = undefined;
            },
            async afterPublish({ previousRetirement, signal }) {
                await previousRetirement;
                if (signal.aborted || retiring || runtime.memoryConsolidationScheduler !== scheduler) return;
                processOwnerAcquired = true;
                previous = undefined;
                scheduler.activate(resumeStarted);
            },
            retire
        }, "publish Manager memory consolidation scheduler");
    }
}).activate;

import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.napcat-supervisor@1");
        context.services.provide("manager.napcat-supervisor@1", Object.freeze({ instanceId: context.identity.instanceId }));
        if (runtime.managerReadOnly || !runtime.managerShouldAutostart) return;
        let controlContext;
        let startupAttempted = false;
        let published = false;
        let ready = false;
        let closed = false;
        let stopping;
        let previousStart;
        let previousStop;
        const supervisor = new runtime.NapcatSupervisorService({
            restartDelayMs: 30_000,
            run: async signal => {
                if (!controlContext) return;
                // Watcher recovery never repeats this activation's startup login pass.
                if (!startupAttempted) {
                    startupAttempted = true;
                    try { await runtime.autoLoginNapcatInstancesOnRabiStart(controlContext, undefined, signal); }
                    catch (error) { console.warn(`NapCat startup pass failed; continuing guardian: ${error instanceof Error ? error.message : String(error)}`); }
                }
                if (signal.aborted) return;
                await runtime.runNapcatGuardianLoop(runtime.napcatGuardianDepsFor(controlContext, {
                    listInstances: () => runtime.napcatGuardianInstances(controlContext),
                    observe: request => runtime.observeNapcatGuardianInstance(controlContext, request),
                    relaunch: request => runtime.relaunchNapcatGuardianInstance(controlContext, request)
                }), signal);
            },
            onError: error => console.warn(`NapCat startup auto login failed: ${error instanceof Error ? error.message : String(error)}`)
        });
        const start = () => {
            if (!published || !ready || closed || !runtime.routeCatalogReady) return;
            void supervisor.start().catch(error => context.lifecycle.fail(error));
        };
        const stop = () => {
            closed = true;
            stopping ??= supervisor.stop();
            return stopping;
        };
        context.effects.add(() => stop, "stop prepared Manager NapCat supervisor");
        context.publication.add({
            publish() {
                previousStart = runtime.startActiveNapcatSupervisor;
                previousStop = runtime.stopActiveNapcatSupervisor;
                controlContext = runtime.activeNapcatControlContext;
                runtime.startActiveNapcatSupervisor = start;
                runtime.stopActiveNapcatSupervisor = stop;
                published = true;
            },
            rollback() {
                published = false;
                ready = false;
                if (runtime.startActiveNapcatSupervisor === start)
                    runtime.startActiveNapcatSupervisor = previousStart;
                if (runtime.stopActiveNapcatSupervisor === stop)
                    runtime.stopActiveNapcatSupervisor = previousStop;
            },
            async afterPublish({ previousRetirement }) {
                // Keep the new driver idle until the old guardian has actually
                // completed. A rejected retirement barrier cannot start it.
                await previousRetirement;
                if (closed) return;
                ready = true;
                if (runtime.managerListenerReady) start();
            },
            async retire() {
                published = false;
                ready = false;
                if (runtime.startActiveNapcatSupervisor === start)
                    runtime.startActiveNapcatSupervisor = () => {};
                if (runtime.stopActiveNapcatSupervisor === stop)
                    runtime.stopActiveNapcatSupervisor = async () => {};
                await stop();
            }
        }, "publish Manager NapCat supervisor");
    }
}).activate;

import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.napcat-control@1");
        context.services.provide("manager.napcat-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
        let accepting = false;
        let published = false;
        let previousContext;
        const assertAccepting = () => {
            if (!accepting) throw new Error("NapCat control plugin is stopping.");
        };
        const controlContext = runtime.napcatManagerCtx(assertAccepting);
        context.publication.add({
            publish() {
                previousContext = runtime.activeNapcatControlContext;
                runtime.activeNapcatControlContext = controlContext;
                published = true;
                accepting = true;
            },
            rollback() {
                accepting = false;
                published = false;
                if (runtime.activeNapcatControlContext === controlContext)
                    runtime.activeNapcatControlContext = previousContext;
            }
        }, "publish Manager NapCat control context");
        context.effects.add(async () => {
            const activeOperations = new Set();
            const runOperation = action => {
                const operation = Promise.resolve().then(() => { assertAccepting(); return action(); });
                activeOperations.add(operation);
                void operation.then(() => activeOperations.delete(operation), () => activeOperations.delete(operation));
                return operation;
            };
            let registration;
            const retire = async () => {
                const retired = registration?.dispose();
                accepting = false;
                const results = await Promise.allSettled([
                    // A failed candidate never owned the driver. After replacement,
                    // the superseded supervisor retires through its own activation.
                    Promise.resolve().then(() => {
                        if (published && runtime.activeNapcatControlContext === controlContext)
                            return runtime.stopActiveNapcatSupervisor();
                    }),
                    (async () => { while (activeOperations.size > 0) await Promise.allSettled([...activeOperations]); await retired; })()
                ]);
                // Bound processes survive Manager handover; the persisted owner reconciles
                // them with the next committed Route snapshot before admitting commands.
                if (runtime.activeNapcatControlContext === controlContext) runtime.activeNapcatControlContext = undefined;
                const failure = results.find(result => result.status === "rejected");
                if (failure) throw failure.reason;
            };
            try {
                registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createNapcatControlOperations({
                    assertCurrent: assertAccepting,
                    repairAll: () => runOperation(runtime.repairAllNapcatInstances),
                    ensureReady: body => runOperation(() => runtime.ensureNapcatInstanceReady(controlContext, body)),
                    health: body => runOperation(() => runtime.testNapcatHealth(controlContext, body)),
                    loginPanel: body => runOperation(() => runtime.readNapcatLoginPanel(controlContext, body)),
                    loginAction: body => runOperation(() => runtime.runNapcatLoginAction(controlContext, body)),
                    configureOneBot: body => runOperation(() => runtime.configureNapcatOneBot(controlContext, body)),
                    add: body => runOperation(() => runtime.addManagedNapcatInstance(body, controlContext)),
                    launch: body => runOperation(() => runtime.launchNapcatInstanceEndpoint(controlContext, body)),
                    restart: body => runOperation(() => runtime.restartNapcatInstanceEndpoint(controlContext, body)),
                    remove: body => runOperation(() => runtime.removeManagedNapcatInstance(body))
                }), context.lifecycle.signal);
                return retire;
            } catch (error) {
                await retire().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.napcat-control");
    }
}).activate;

import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
    activate(context) {
        const runtime = context.services.require("host.manager.agent-adapter-catalog@1");
        context.services.provide("manager.agent-adapter-catalog@1", Object.freeze({ instanceId: context.identity.instanceId }));
        let mount;
        let previousService;
        let disposal;
        const stopOwner = () => disposal ??= Promise.resolve().then(() =>
            mount?.stop("Manager Agent adapter catalog plugin stopped."));

        context.effects.add(async () => {
            mount = await runtime.mountAgentAdapterCatalogPlugin({
                rootDir: runtime.rootDir,
                getRuntimes: () => runtime.runtimes.values(),
                adopt: disposer => context.effects.adopt(disposer, "prepared Agent adapter catalog owner"),
                registerOperations: async definitions => await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, definitions, context.lifecycle.signal)
            });
            return stopOwner;
        }, "prepare Manager Agent adapter catalog");

        context.publication.add({
            publish() {
                if (!mount) throw new Error("Manager Agent adapter catalog was not prepared.");
                previousService = runtime.agentAdapterCatalogService;
                runtime.agentAdapterCatalogService = mount.service;
            },
            rollback() {
                if (runtime.agentAdapterCatalogService === mount?.service)
                    runtime.agentAdapterCatalogService = previousService;
            },
            async retire() {
                if (runtime.agentAdapterCatalogService === mount.service)
                    runtime.agentAdapterCatalogService = undefined;
                await stopOwner();
            }
        }, "Manager Agent adapter catalog owner");
    }
}).activate;

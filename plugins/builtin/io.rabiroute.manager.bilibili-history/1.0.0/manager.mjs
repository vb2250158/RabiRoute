import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    activate(context) {
        const runtime = context.services.require("host.manager.bilibili-history@1");
        const bridge = new runtime.BilibiliHistoryBridge(
            runtime.path.join(runtime.rootDir, "data", "runtime", "bilibili-history-bridge.json"),
            () => runtime.configRepository.rolesRoot,
            { readOnly: runtime.managerReadOnly }
        );
        // Allocation is read-only; even a later registration failure owns its cleanup.
        context.effects.adopt(() => bridge.close(), "close Bilibili history candidate owner");
        context.services.provide("manager.bilibili-history@1", Object.freeze({ instanceId: context.identity.instanceId }));
        context.effects.add(async () => {
            const operations = await runtime.managerPluginRoutes.registerOperationsAsync(
                context.identity.instanceId, runtime.createBilibiliHistoryOperations(bridge)
            , context.lifecycle.signal);
            return async () => {
                bridge.close();
                await operations.dispose();
            };
        }, "register Manager Bilibili history operations");
        context.publication.add({
            // No shared pointer is owned here. State migration is irreversible I/O
            // and belongs exclusively to the post-publication phase below.
            publish() {},
            rollback() {},
            async afterPublish({ previousRetirement, signal }) {
                await previousRetirement;
                signal.throwIfAborted();
                bridge.publish();
            }
        }, "resume published Bilibili history queue");
    }
}).activate;

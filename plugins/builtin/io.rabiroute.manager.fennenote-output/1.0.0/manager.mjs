import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.fennenote-output@1");
        context.services.provide("manager.fennenote-output@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const service = new runtime.FenneNoteOutputService({
            playbackUrl: runtime.fenneNotePlaybackUrl,
            playbackToken: runtime.fenneNotePlaybackToken,
            replyUrl: runtime.fenneNoteReplyUrl,
            replyToken: runtime.fenneNoteReplyToken
        });
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:fennenote-output", "manager.fennenote-output.api", [
                requestTracker.wrap((request, requestUrl, response) => service.handle(request, requestUrl, response))
            ], [
                { routeId: "reply", kind: "exact", path: "/api/fennenote/reply", methods: ["POST"] },
                { routeId: "playback", kind: "exact", path: "/api/fennenote/playback", methods: ["POST"] }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
                await service.stop();
            };
        }, "activate Manager FenneNote output plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.fennenote-output");
    }
}).activate;

export async function activate(context) {
  const events = context.services.require("host.test-events@1");
  context.services.provide("message.source.fixture@1", Object.freeze({ revision: "one" }));
  context.contributions.register({ kind: "message-source", id: "fixture-source", value: { hosts: ["manager"] } });
  context.effects.add(() => {
    events.push(`start:${context.identity.instanceId}:${context.identity.revision}`);
    return () => { events.push(`stop:${context.identity.instanceId}:${context.identity.revision}`); };
  }, "fixture message source");
}

export async function activate(context) {
  const events = context.services.require("host.test-events@1");
  const adapter = context.services.require("agent.adapter.fixture@1");
  context.services.provide("route.policy.fixture@1", Object.freeze({ adapterRevision: adapter.sourceRevision }));
  context.contributions.register({ kind: "route-policy", id: "fixture-policy", value: { hosts: ["manager"] } });
  context.effects.add(() => {
    events.push(`start:${context.identity.instanceId}:${context.identity.revision}`);
    return () => { events.push(`stop:${context.identity.instanceId}:${context.identity.revision}`); };
  }, "fixture route policy");
}

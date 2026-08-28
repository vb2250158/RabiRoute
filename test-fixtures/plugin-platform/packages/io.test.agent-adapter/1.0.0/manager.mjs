export async function activate(context) {
  const events = context.services.require("host.test-events@1");
  const source = context.services.require("message.source.fixture@1");
  context.services.provide("agent.adapter.fixture@1", Object.freeze({ sourceRevision: source.revision }));
  context.contributions.register({ kind: "agent-adapter", id: "fixture-agent", value: { hosts: ["manager"] } });
  context.effects.add(() => {
    events.push(`start:${context.identity.instanceId}:${context.identity.revision}`);
    return () => { events.push(`stop:${context.identity.instanceId}:${context.identity.revision}`); };
  }, "fixture agent adapter");
}

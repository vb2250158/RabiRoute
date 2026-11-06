# Automation scheduler

[简体中文](README.md)

Runs scheduled rules configured under the role's Automation section. It has no message-connector card, login entry, or scan item. The Gateway loads this package from enabled rules and their source Route scope. Its single plugin lifecycle releases timers on deactivation and exit.

The internal `heartbeat` ID preserves the existing execution, delivery, and history contract without a second engine. The official persona configuration upgrade retains legacy task IDs, enabled states, and Route scopes. An inherited busy policy preserves differences between existing Routes. Configure new tasks directly in Automation.

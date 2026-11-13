# Automation scheduler

[简体中文](README.md)

Runs scheduled rules configured under the role's Automation section. It has no message-connector card, login entry, or scan item. The Gateway loads this package from enabled rules and their source Route scope. For rules explicitly addressed to DS Bot, this package's Manager entry consumes the Persona plugin's automation source without requiring a Route or primary session. Both entries share the timer calculation; Gateway task collection excludes DS Bot rules to prevent duplicate execution.

The Persona plugin owns configuration reads, change notifications and native role work leases; the Manager scheduler owns timers and in-flight delivery. Configuration changes refresh the source through the existing catalog lifecycle. Retirement unsubscribes, clears timers and awaits actual reads and deliveries. Executions reuse the original automation ledger, identifying receipts by role, original rule ID and planned firing time. Local connection references and remote bindings pass unchanged to existing Agent Thread routing. An invalid rule or unavailable target reports that item without stopping other rules. Native receipts distinguish DS Bot queue acceptance from unknown outcomes.

The internal `heartbeat` ID preserves the existing execution, delivery, and history contract without a second engine. The official persona configuration upgrade retains legacy task IDs, enabled states, and Route scopes. An inherited busy policy preserves differences between existing Routes. Configure new tasks directly in Automation.

A daily rule can store several local times in `timeOfDays`, such as `10:00`, `14:00` and `18:00`. The scheduler runs the remaining points today and moves to the first point tomorrow after the final one; missed points retain the existing no-catch-up behavior. All points share one rule and runtime task, while the existing receipt key includes the planned firing time. Legacy `timeOfDay` remains supported. An invalid list stops only that schedule; other valid rules continue running.

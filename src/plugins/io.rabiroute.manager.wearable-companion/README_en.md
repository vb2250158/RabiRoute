[简体中文](./README.md) | English

# Wearable Health Companion

This Manager plugin keeps RabiLink wearable-health synchronization inside the current RabiRoute application generation.

- Manager Plugin Kernel activates the plugin with Host-issued runtime identity; candidate preparation neither launches a worker nor creates state or log directories.
- Only the official `context.publication.add.afterPublish` starts the existing launch path after successful publication, previous retirement, and cancellation checks. Manager startupReady still gates the actual spawn.
- Manager's `ProcessLeaseRegistry` directly owns the PowerShell worker and releases its process tree when the plugin or application generation stops.
- The worker uses only the dynamic Manager URL published by Host READY and sends `applicationGenerationId` plus `managerInstanceId` with every write.
- Missing mobile, ADB, or PowerShell dependencies produce a diagnosable degraded state without a separate scheduled task or port probing.

Scripts under `resources/` are managed worker resources, not standalone lifecycle entry points.

Publication failure preserves the old worker. Retirement joins only its own child's actual `close`; neither `exit` nor removal of the lease proves completed cleanup, and an old activation cannot stop its replacement. Repeated disposal shares one cleanup attempt. Isolated tests in `src/manager/gatewayWearablePublication.test.ts` use controlled child emitters with the native lease service, without running PowerShell, ADB, or real devices.

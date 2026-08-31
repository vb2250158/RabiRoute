# Wearable Health Companion

This Manager plugin keeps RabiLink wearable-health synchronization inside the current RabiRoute application generation.

- Manager Plugin Kernel activates the plugin with Host-issued runtime identity.
- Manager's `ProcessLeaseRegistry` directly owns the PowerShell worker and releases its process tree when the plugin or application generation stops.
- The worker uses only the dynamic Manager URL published by Host READY and sends `applicationGenerationId` plus `managerInstanceId` with every write.
- Missing mobile, ADB, or PowerShell dependencies produce a diagnosable degraded state without a separate scheduled task or port probing.

Scripts under `resources/` are managed worker resources, not standalone lifecycle entry points.

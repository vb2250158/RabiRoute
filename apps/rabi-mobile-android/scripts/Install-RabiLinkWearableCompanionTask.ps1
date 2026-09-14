[CmdletBinding()]
param(
    [string]$TaskName = "RabiLinkWearableHealthCompanion",
    [switch]$StartNow,
    [switch]$Uninstall,
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
$note = "The scheduled-task wearable companion is retired. RabiRouteHost owns the optional Manager plugin and its worker lifecycle."

if ($Execute) {
    throw "$note This compatibility command never registers, starts, stops, or removes a scheduled task; use the RabiRoute Setup migration for an existing legacy task."
}

[pscustomobject]@{
    Mode = "retired-diagnostic"
    TaskName = $TaskName
    Installed = $false
    WouldMutateScheduledTask = $false
    RequestedAction = if ($Uninstall) { "uninstall" } elseif ($StartNow) { "start" } else { "install" }
    Note = $note
}

[CmdletBinding()]
param([Parameter(Mandatory)][string]$HostExe)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Resolve-RabiRouteHostManagerUrl.ps1")
$identity = Resolve-RabiRouteHostManagerIdentity -HostExe $HostExe

[pscustomobject]@{
    Mode = "diagnostic"
    HostExe = $identity.HostExe
    ManagerBaseUrl = $identity.ManagerBaseUrl
    ApplicationGenerationId = $identity.ApplicationGenerationId
    ManagerInstanceId = $identity.ManagerInstanceId
    WorkerStarted = $false
    Note = "The wearable companion worker is started only by the Host-owned Manager plugin."
}

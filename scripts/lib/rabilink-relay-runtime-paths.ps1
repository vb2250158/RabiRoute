# Format only: the explicit runtime manifest owns the selected files.
function Test-RelayRuntimePath {
    param([string]$Relative, [Parameter(Mandatory=$true)]$Rules, [switch]$Legacy)
    return ($Relative -match $Rules.runtime -or ($Legacy -and $Relative -match $Rules.legacy))
}

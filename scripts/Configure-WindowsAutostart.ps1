param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [ValidateSet("true", "false")]
    [string]$Enabled,
    [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [string]::Equals((Resolve-FullPath $Left), (Resolve-FullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Read-Shortcut([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    return [pscustomobject]@{
        TargetPath = [string]$shortcut.TargetPath
        Arguments = [string]$shortcut.Arguments
        WorkingDirectory = [string]$shortcut.WorkingDirectory
    }
}

function Get-ShortcutOwnership([string]$Path, [string[]]$AllowedTargets, [string]$ExpectedWorkingDirectory) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "absent" }
    try {
        $shortcut = Read-Shortcut $Path
        $targetAllowed = $false
        foreach ($candidate in $AllowedTargets) {
            if ($shortcut.TargetPath -and (Test-SamePath $shortcut.TargetPath $candidate)) {
                $targetAllowed = $true
                break
            }
        }
        if ($targetAllowed -and -not $shortcut.Arguments.Trim() -and
            $shortcut.WorkingDirectory -and (Test-SamePath $shortcut.WorkingDirectory $ExpectedWorkingDirectory)) {
            return "owned"
        }
    } catch {
        return "foreign"
    }
    return "foreign"
}

function Write-BytesDurably([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Replace-File([string]$TemporaryPath, [string]$DestinationPath) {
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        $replaceBackup = "$DestinationPath.$PID.$([guid]::NewGuid().ToString('N')).replace-backup"
        try {
            [IO.File]::Replace($TemporaryPath, $DestinationPath, $replaceBackup, $true)
        } finally {
            Remove-Item -LiteralPath $replaceBackup -Force -ErrorAction SilentlyContinue
        }
    } else {
        [IO.File]::Move($TemporaryPath, $DestinationPath)
    }
}

$install = Resolve-FullPath $InstallRoot
if (-not [IO.Path]::IsPathRooted($install) -or $install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\')) {
    throw "InstallRoot must be an absolute application directory, not a drive root."
}
$appData = [Environment]::GetEnvironmentVariable("APPDATA")
if (-not $appData) { throw "APPDATA is unavailable; cannot manage the current-user login entry." }

$settingsPath = Join-Path $install "data\desktop\settings.json"
$startupDirectory = Join-Path $appData "Microsoft\Windows\Start Menu\Programs\Startup"
$startupPath = Join-Path $startupDirectory "RabiRoute.lnk"
$legacyStartupPath = Join-Path $startupDirectory "RabiRoute Desktop.lnk"
$hostPath = Join-Path $install "RabiRouteHost.exe"
$allowedTargets = @(
    $hostPath,
    (Join-Path $install "RabiRoute-Desktop.exe"),
    (Join-Path $install "RabiRoute-Tray.exe"),
    (Join-Path $install "Start-RabiRoute-Desktop.bat")
)

$settings = [pscustomobject][ordered]@{}
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $parsed = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $parsed -or $parsed -isnot [pscustomobject]) {
        throw "Desktop settings must contain one JSON object."
    }
    $settings = $parsed
}

$startupOwnership = Get-ShortcutOwnership $startupPath $allowedTargets $install
$legacyOwnership = Get-ShortcutOwnership $legacyStartupPath $allowedTargets $install
if ($startupOwnership -eq "foreign") { throw "Startup\RabiRoute.lnk is not owned by this RabiRoute installation; refusing to overwrite it." }
if ($legacyOwnership -eq "foreign") { throw "Startup\RabiRoute Desktop.lnk is not owned by this RabiRoute installation; refusing to delete it." }
if ($PreflightOnly) {
    [pscustomobject]@{ ok = $true; preflight = $true; startup = $startupOwnership; legacyStartup = $legacyOwnership } | ConvertTo-Json -Compress
    exit 0
}
if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) { throw "RabiRouteHost.exe is unavailable after payload installation." }

$settingsExisted = Test-Path -LiteralPath $settingsPath -PathType Leaf
$settingsBytes = if ($settingsExisted) { [IO.File]::ReadAllBytes($settingsPath) } else { $null }
$startupExisted = Test-Path -LiteralPath $startupPath -PathType Leaf
$startupBytes = if ($startupExisted) { [IO.File]::ReadAllBytes($startupPath) } else { $null }
$legacyExisted = Test-Path -LiteralPath $legacyStartupPath -PathType Leaf
$legacyBytes = if ($legacyExisted) { [IO.File]::ReadAllBytes($legacyStartupPath) } else { $null }
$settingsTemporary = "$settingsPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
$shortcutTemporary = "$startupPath.$PID.$([guid]::NewGuid().ToString('N')).tmp.lnk"

try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($settingsPath)) | Out-Null
    [IO.Directory]::CreateDirectory($startupDirectory) | Out-Null
    if ($settings.PSObject.Properties.Name -contains "autostart") {
        $settings.autostart = ($Enabled -eq "true")
    } else {
        $settings | Add-Member -NotePropertyName autostart -NotePropertyValue ($Enabled -eq "true")
    }
    $json = ($settings | ConvertTo-Json -Depth 100) + "`n"
    Write-BytesDurably $settingsTemporary ([Text.UTF8Encoding]::new($false).GetBytes($json))
    Replace-File $settingsTemporary $settingsPath

    if ($Enabled -eq "true") {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutTemporary)
        $shortcut.TargetPath = $hostPath
        $shortcut.Arguments = ""
        $shortcut.WorkingDirectory = $install
        $shortcut.IconLocation = (Join-Path $install "assets\rabiroute-icon.ico") + ",0"
        $shortcut.Save()
        Replace-File $shortcutTemporary $startupPath
    } elseif ($startupOwnership -eq "owned") {
        Remove-Item -LiteralPath $startupPath -Force
    }
    if ($legacyOwnership -eq "owned") { Remove-Item -LiteralPath $legacyStartupPath -Force }

    $verified = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($verified.autostart -isnot [bool] -or $verified.autostart -ne ($Enabled -eq "true")) {
        throw "Desktop autostart setting verification failed."
    }
    $projected = Get-ShortcutOwnership $startupPath @($hostPath) $install
    if (($Enabled -eq "true" -and $projected -ne "owned") -or ($Enabled -eq "false" -and $projected -ne "absent")) {
        throw "Host-only startup shortcut verification failed."
    }
    if ((Get-ShortcutOwnership $legacyStartupPath $allowedTargets $install) -ne "absent") {
        throw "Legacy desktop startup shortcut remained after reconciliation."
    }
} catch {
    Remove-Item -LiteralPath $settingsTemporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $shortcutTemporary -Force -ErrorAction SilentlyContinue
    if ($settingsExisted) { [IO.File]::WriteAllBytes($settingsPath, $settingsBytes) } else { Remove-Item -LiteralPath $settingsPath -Force -ErrorAction SilentlyContinue }
    if ($startupExisted) { [IO.File]::WriteAllBytes($startupPath, $startupBytes) } else { Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue }
    if ($legacyExisted) { [IO.File]::WriteAllBytes($legacyStartupPath, $legacyBytes) } else { Remove-Item -LiteralPath $legacyStartupPath -Force -ErrorAction SilentlyContinue }
    throw
} finally {
    Remove-Item -LiteralPath $settingsTemporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $shortcutTemporary -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{ ok = $true; autostart = ($Enabled -eq "true"); settingsPath = $settingsPath; startupPath = $startupPath } | ConvertTo-Json -Compress

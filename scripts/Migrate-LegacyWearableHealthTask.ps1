[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Inspect", "Remove", "Restore")]
    [string]$Mode,

    [string]$BackupRoot,
    [string]$TaskStorePath
)

$ErrorActionPreference = "Stop"
$TaskName = "RabiLinkWearableHealthCompanion"
$TaskPath = '\'
$LegacyDescription = "RabiLink 小米手表/手环健康 ADB Companion；配置真源在手机端。"
$BackupSchemaVersion = 1
$LegacyManagerUrl = "http://127.0.0.1:" + "8790"

function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }

function Write-Durable([string]$Path, [byte[]]$Bytes) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName((Full $Path))) | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $replaceBackup = "$temporary.replace"
        [IO.File]::Replace($temporary, $Path, $replaceBackup, $true)
        Remove-Item -LiteralPath $replaceBackup -Force -ErrorAction SilentlyContinue
    } else {
        [IO.File]::Move($temporary, $Path)
    }
}

function Write-JsonDurable([string]$Path, [object]$Value) {
    $json = ($Value | ConvertTo-Json -Depth 30) + "`n"
    Write-Durable $Path ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Get-Sha256Text([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Resolve-AccountSid([string]$Account) {
    if ([string]::IsNullOrWhiteSpace($Account)) { throw "Scheduled task account is empty." }
    if ($Account -match '^S-\d-(?:\d+-){1,14}\d+$') { return $Account }
    try {
        return ([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        throw "Scheduled task account cannot be resolved to a SID: $Account"
    }
}

function Get-CurrentSid {
    if ($TaskStorePath) {
        $store = Get-Content -LiteralPath $TaskStorePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $sid = [string]$store.currentSid
        if ($sid -notmatch '^S-\d-(?:\d+-){1,14}\d+$') { throw "Fake task store has an invalid currentSid." }
        return $sid
    }
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-ArgumentValue([string]$Arguments, [string]$Name) {
    $escapedName = [Text.RegularExpressions.Regex]::Escape($Name)
    $patternTemplate = @'
(?i)(?:^|\s)-{0}\s+(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>\S+))(?=\s|$)
'@
    $match = [Text.RegularExpressions.Regex]::Match($Arguments, ($patternTemplate -f $escapedName))
    if (-not $match.Success) { return $null }
    foreach ($group in @("double", "single", "bare")) {
        if ($match.Groups[$group].Success) { return $match.Groups[$group].Value }
    }
    return $null
}

function Test-LegacyRunner([string]$Runner) {
    if ([string]::IsNullOrWhiteSpace($Runner) -or -not [IO.Path]::IsPathRooted($Runner)) { return $false }
    $normalized = $Runner.Replace('/', '\')
    return $normalized -match '(?i)^(?:Z:\\DigitalLife\\|\\\\smartstorage\\[^\\]+\\DigitalLife\\)RabiRoute\\(?:examples\\android-rabi-link-probe|apps\\rabilink-android)\\scripts\\Start-RabiLinkWearableCompanion\.ps1$'
}

function Assert-LegacyArguments([string]$Arguments, [string]$WorkingDirectory) {
    $runner = Get-ArgumentValue $Arguments "File"
    $managerUrl = Get-ArgumentValue $Arguments "ManagerUrl"
    $roleId = Get-ArgumentValue $Arguments "RoleId"
    if (-not (Test-LegacyRunner $runner)) { throw "The same-name task does not use the retired NAS wearable companion runner." }
    if ($managerUrl -cne $LegacyManagerUrl) { throw "The same-name task does not use the retired fixed Manager URL." }
    if ($roleId -cne "YeYu") { throw "The same-name task does not use the retired RoleId contract." }
    if ((Full $WorkingDirectory) -ne (Full ([IO.Path]::GetDirectoryName($runner)))) {
        throw "The same-name task working directory does not match its retired runner."
    }
    $escapedManagerUrl = [Text.RegularExpressions.Regex]::Escape($LegacyManagerUrl)
    $expected = '^\s*-NoLogo\s+-NoProfile\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass\s+-File\s+(?:"[^"]+"|''[^'']+''|\S+)\s+-ManagerUrl\s+(?:"{0}"|''{0}''|{0})\s+-RoleId\s+(?:"YeYu"|''YeYu''|YeYu)\s*$' -f $escapedManagerUrl
    if ($Arguments -notmatch $expected) { throw "The same-name task has unknown or reordered action arguments." }
}

function Read-FakeStore {
    $store = Get-Content -LiteralPath $TaskStorePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($store.schemaVersion -ne 1 -or $null -eq $store.tasks) { throw "Fake task store is malformed." }
    return $store
}

function Get-TaskCandidates {
    if ($TaskStorePath) {
        $store = Read-FakeStore
        return @($store.tasks | Where-Object { [string]$_.taskName -ceq $TaskName })
    }
    try {
        return @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    } catch {
        throw "Could not inspect the legacy wearable scheduled task: $($_.Exception.Message)"
    }
}

function Assert-ManagedTask($Task, [string]$CurrentSid) {
    if ([string]$Task.TaskName -cne $TaskName -or [string]$Task.TaskPath -cne $TaskPath) {
        throw "The same-name task is not the retired root task."
    }
    $principalSid = Resolve-AccountSid ([string]$Task.Principal.UserId)
    if ($principalSid -cne $CurrentSid) { throw "The same-name task belongs to a different Windows SID." }
    if ([string]$Task.Principal.LogonType -notin @("Interactive", "InteractiveToken") -or [string]$Task.Principal.RunLevel -ne "Limited") {
        throw "The same-name task principal is not the retired interactive limited principal."
    }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1) { throw "The same-name task does not have exactly one logon trigger." }
    $triggerType = if ($TaskStorePath) { [string]$triggers[0].type } else { [string]$triggers[0].CimClass.CimClassName }
    if ($triggerType -notin @("Logon", "MSFT_TaskLogonTrigger")) { throw "The same-name task trigger is not a logon trigger." }
    $triggerSid = Resolve-AccountSid ([string]$triggers[0].UserId)
    if ($triggerSid -cne $CurrentSid) { throw "The same-name task logon trigger belongs to a different Windows SID." }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "The same-name task does not have exactly one action." }
    if ([IO.Path]::GetFileName([string]$actions[0].Execute) -ine "pwsh.exe") { throw "The same-name task action is not the retired pwsh runner." }
    Assert-LegacyArguments ([string]$actions[0].Arguments) ([string]$actions[0].WorkingDirectory)
    if ([string]$Task.Description -cne $LegacyDescription) { throw "The same-name task description is not the retired product contract." }
}

function Get-ManagedTask {
    $candidates = @(Get-TaskCandidates)
    if ($candidates.Count -eq 0) { return $null }
    if ($candidates.Count -ne 1) { throw "Multiple scheduled tasks share the retired wearable task name." }
    Assert-ManagedTask $candidates[0] (Get-CurrentSid)
    return $candidates[0]
}

function Get-TaskXml($Task) {
    if ($TaskStorePath) { return [string]$Task.xml }
    return Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
}

function Save-Backup($Task) {
    if ([string]::IsNullOrWhiteSpace($BackupRoot)) { throw "BackupRoot is required for Remove." }
    $root = Full $BackupRoot
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $metadataPath = Join-Path $root "task-backup.json"
    $xmlPath = Join-Path $root "task.xml"
    if ((Test-Path -LiteralPath $metadataPath) -or (Test-Path -LiteralPath $xmlPath)) {
        throw "Legacy task backup already exists; refusing to overwrite recovery evidence."
    }
    if ($null -eq $Task) {
        Write-JsonDurable $metadataPath ([ordered]@{
            schemaVersion=$BackupSchemaVersion; taskName=$TaskName; taskPath=$TaskPath; wasPresent=$false; wasRunning=$false
        })
        return
    }
    $xml = Get-TaskXml $Task
    if ([string]::IsNullOrWhiteSpace($xml)) { throw "Legacy task XML export is empty." }
    Write-Durable $xmlPath ([Text.UTF8Encoding]::new($false).GetBytes($xml))
    $snapshot = if ($TaskStorePath) { $Task } else { $null }
    Write-JsonDurable $metadataPath ([ordered]@{
        schemaVersion=$BackupSchemaVersion
        taskName=$TaskName
        taskPath=$TaskPath
        wasPresent=$true
        wasRunning=([string]$Task.State -in @("Running", "Queued"))
        xmlSha256=(Get-Sha256Text $xml)
        fakeTaskSnapshot=$snapshot
    })
}

function Write-FakeStore($Store) {
    Write-JsonDurable $TaskStorePath $Store
}

function Remove-ManagedTask($Task) {
    if ($null -eq $Task) { return }
    # Re-read and revalidate immediately before the first mutation so a
    # same-name replacement cannot inherit the earlier ownership decision.
    $current = Get-ManagedTask
    if ($null -eq $current) { throw "The managed legacy task disappeared before removal." }
    if ((Get-Sha256Text (Get-TaskXml $current)) -ne (Get-Sha256Text (Get-TaskXml $Task))) {
        throw "The legacy task changed after backup; refusing mutation."
    }
    if ($TaskStorePath) {
        $store = Read-FakeStore
        $store.tasks = @($store.tasks | Where-Object { [string]$_.taskName -cne $TaskName })
        Write-FakeStore $store
        return
    }
    if ([string]$current.State -in @("Running", "Queued")) {
        Stop-ScheduledTask -InputObject $current -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            $remaining = Get-ManagedTask
            if ($null -eq $remaining -or [string]$remaining.State -notin @("Running", "Queued")) { break }
            Start-Sleep -Milliseconds 100
        }
        $remaining = Get-ManagedTask
        if ($remaining -and [string]$remaining.State -in @("Running", "Queued")) { throw "The managed legacy task did not stop within 10 seconds." }
    }
    $remaining = Get-ManagedTask
    if ($remaining) { Unregister-ScheduledTask -InputObject $remaining -Confirm:$false -ErrorAction Stop }
    if ($null -ne (Get-ManagedTask)) { throw "The managed legacy task is still registered after removal." }
}

function Read-Backup {
    if ([string]::IsNullOrWhiteSpace($BackupRoot)) { throw "BackupRoot is required for Restore." }
    $metadataPath = Join-Path (Full $BackupRoot) "task-backup.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw "Legacy task recovery metadata is missing." }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($metadata.schemaVersion -ne $BackupSchemaVersion -or [string]$metadata.taskName -cne $TaskName -or [string]$metadata.taskPath -cne $TaskPath) {
        throw "Legacy task recovery metadata has a foreign identity."
    }
    if ([bool]$metadata.wasPresent) {
        $xmlPath = Join-Path (Full $BackupRoot) "task.xml"
        if (-not (Test-Path -LiteralPath $xmlPath -PathType Leaf)) { throw "Legacy task recovery XML is missing." }
        $xml = Get-Content -LiteralPath $xmlPath -Raw -Encoding UTF8
        if ((Get-Sha256Text $xml) -ne [string]$metadata.xmlSha256) { throw "Legacy task recovery XML hash mismatch." }
        $metadata | Add-Member -NotePropertyName recoveredXml -NotePropertyValue $xml
    }
    return $metadata
}

function Restore-ManagedTask {
    $metadata = Read-Backup
    $existing = Get-ManagedTask
    if (-not [bool]$metadata.wasPresent) {
        if ($existing) { throw "A same-name task appeared after the absent-task backup; refusing mutation." }
        return
    }
    if ($existing) {
        if ((Get-Sha256Text (Get-TaskXml $existing)) -ne [string]$metadata.xmlSha256) {
            throw "A different same-name task blocks legacy task restoration."
        }
    } elseif ($TaskStorePath) {
        $store = Read-FakeStore
        $store.tasks = @($store.tasks) + @($metadata.fakeTaskSnapshot)
        Write-FakeStore $store
        $existing = Get-ManagedTask
    } else {
        Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml ([string]$metadata.recoveredXml) -ErrorAction Stop | Out-Null
        $existing = Get-ManagedTask
    }
    $isRunning = [string]$existing.State -in @("Running", "Queued")
    if ([bool]$metadata.wasRunning -and -not $isRunning) {
        if ($TaskStorePath) {
            $store = Read-FakeStore
            foreach ($task in @($store.tasks)) { if ([string]$task.taskName -ceq $TaskName) { $task.state = "Running" } }
            Write-FakeStore $store
        } else { Start-ScheduledTask -InputObject $existing -ErrorAction Stop }
    } elseif (-not [bool]$metadata.wasRunning -and $isRunning) {
        if ($TaskStorePath) {
            $store = Read-FakeStore
            foreach ($task in @($store.tasks)) { if ([string]$task.taskName -ceq $TaskName) { $task.state = "Ready" } }
            Write-FakeStore $store
        } else { Stop-ScheduledTask -InputObject $existing -ErrorAction Stop }
    }
}

if ($TaskStorePath -and $env:RABIROUTE_INSTALL_TRANSACTION_TEST_MODE -ne "1") {
    throw "TaskStorePath is forbidden outside explicit transaction test mode."
}
if ($TaskStorePath -and -not (Test-Path -LiteralPath $TaskStorePath -PathType Leaf)) {
    throw "Fake task store is missing."
}

switch ($Mode) {
    "Inspect" {
        $task = Get-ManagedTask
        [pscustomobject]@{ ok=$true; state=$(if ($task) { "managed" } else { "absent" }); taskName=$TaskName } | ConvertTo-Json -Compress
    }
    "Remove" {
        $task = Get-ManagedTask
        Save-Backup $task
        Remove-ManagedTask $task
        [pscustomobject]@{ ok=$true; state=$(if ($task) { "removed" } else { "already-absent" }); taskName=$TaskName } | ConvertTo-Json -Compress
    }
    "Restore" {
        Restore-ManagedTask
        [pscustomobject]@{ ok=$true; state="restored"; taskName=$TaskName } | ConvertTo-Json -Compress
    }
}

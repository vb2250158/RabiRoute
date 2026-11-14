param(
    [ValidateSet('Install', 'Start', 'Recover', 'Observe')][string]$Operation = 'Install',
    [Parameter(Mandatory = $true)][string]$Root,
    [ValidateSet('yes', 'no')][string]$AutoStart = 'no',
    [string]$OperationId = '',
    [string]$OperationStartedAt = ''
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $OperationId) { $OperationId = [guid]::NewGuid().ToString('D') }
if ($OperationId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Invalid operation identity.' }
if (-not $OperationStartedAt) { $OperationStartedAt = [DateTime]::UtcNow.ToString('o') }
$operationStarted = [DateTimeOffset]::Parse($OperationStartedAt).UtcDateTime
if ([Math]::Abs(([DateTime]::UtcNow - $operationStarted).TotalMinutes) -gt 5) { throw 'Operation identity is stale.' }
$script:operationResultEmitted = $false
$script:ownedVmVerified = $false
$Root = [IO.Path]::GetFullPath($Root)
if ($Root.StartsWith('\\') -or $Root.Contains('"')) { throw 'Installation requires a local directory.' }
$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$([IO.Path]::GetPathRoot($Root).TrimEnd('\'))'"
if (-not $drive -or $drive.DriveType -ne 3) { throw 'Installation requires a fixed local disk.' }
for ($parent = $Root; $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths cannot contain reparse points.' }
}
if ($Operation -eq 'Observe') {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Write-Output 'RABIROUTE_HA_OBSERVATION:{"ready":false}'; return }
} else { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
$statusPath = Join-Path $Root 'status.json'
function Write-Status([string]$State, [string]$Message, [string]$Version = '', [string]$Phase = '', [long]$CompletedBytes = 0, [long]$TotalBytes = 0) {
    $value = @{ state = $State; message = $Message; version = $Version; root = $Root; updatedAt = [DateTime]::UtcNow.ToString('o') }
    if ($OperationId) { $value.operationId = $OperationId; $value.operationStartedAt = $OperationStartedAt }
    if ($Phase) {
        $value.progress = @{ phase = $Phase }
        if ($TotalBytes -gt 0) {
            $value.progress.completedBytes = $CompletedBytes
            $value.progress.totalBytes = $TotalBytes
            $value.progress.percent = [Math]::Min(100, [Math]::Floor(100.0 * $CompletedBytes / $TotalBytes))
        }
    }
    $temporary = Join-Path $Root ('status-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $statusPath) { [IO.File]::Replace($temporary, $statusPath, (Join-Path $Root 'status.previous.json')) }
    else { [IO.File]::Move($temporary, $statusPath) }
}

function Save-ImageDownload([string]$Uri, [string]$Destination, [long]$ExpectedSize, [string]$Version) {
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.UserAgent = 'RabiRoute-HomeAssistant-Setup'
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        Write-Status 'installing' '正在下载 Home Assistant OS。' $Version 'download' 0 $ExpectedSize
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Create($Destination)
        $buffer = New-Object byte[] 1048576
        $completed = 0L
        $lastUpdate = [DateTime]::UtcNow
        $deadline = $lastUpdate.AddMinutes(20)
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $count)
            $completed += $count
            if ($completed -gt $ExpectedSize) { throw 'Image exceeds its declared size.' }
            $now = [DateTime]::UtcNow
            if ($now -gt $deadline) { throw 'Image download timed out.' }
            if (($now - $lastUpdate).TotalMilliseconds -ge 500) {
                Write-Status 'installing' '正在下载 Home Assistant OS。' $Version 'download' $completed $ExpectedSize
                $lastUpdate = $now
            }
        }
        if ($completed -ne $ExpectedSize) { throw 'Image download is incomplete.' }
        Write-Status 'installing' '镜像下载完成。' $Version 'download' $completed $ExpectedSize
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-InstallationDisk([string]$AttachedPath, [string]$ExpectedPath, [bool]$RejectReparse = $false) {
    # Hyper-V may attach an automatic checkpoint instead of the base VHDX.
    $expected = [IO.Path]::GetFullPath($ExpectedPath)
    $directory = [IO.Path]::GetDirectoryName($expected)
    $visited = @{}
    while ($AttachedPath) {
        $current = [IO.Path]::GetFullPath($AttachedPath)
        if ($RejectReparse -and (-not (Test-Path -LiteralPath $current -PathType Leaf) -or ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { return $false }
        if ($current -eq $expected) { return $true }
        if ([IO.Path]::GetDirectoryName($current) -ne $directory -or $visited.ContainsKey($current) -or $visited.Count -ge 64) { return $false }
        $visited[$current] = $true
        $AttachedPath = (Get-VHD -Path $current -ErrorAction Stop).ParentPath
    }
    return $false
}


function Test-HomeAssistantCore([string]$Address, [int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri ("http://${Address}:${Port}/api/") -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
        return $response.StatusCode -eq 200 -and $response.Content -match 'API running'
    } catch {
        if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { return $false }
        try {
            $manifest = Invoke-RestMethod -Uri ("http://${Address}:${Port}/manifest.json") -TimeoutSec 3 -MaximumRedirection 0
            return $manifest.name -eq 'Home Assistant'
        } catch { return $false }
    }
}

function Test-OwnedLegacyLoopback($Vm) {
    $receiptFile = Join-Path $Root 'loopback-proxy.json'
    if (-not (Test-Path -LiteralPath $receiptFile -PathType Leaf)) { return $false }
    try {
        if ((Get-Item -LiteralPath $receiptFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
        if ([string]$receipt.vmId -cne [string]$Vm.Id -or [int]$receipt.port -notin @(80, 8123)) { return $false }
        $legacyAddress = $null
        if (-not [Net.IPAddress]::TryParse([string]$receipt.address, [ref]$legacyAddress) -or
            $legacyAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
            $legacyAddress.ToString() -cne [string]$receipt.address -or
            [string]$receipt.address -match '^(0\.|127\.|169\.254\.)' -or $legacyAddress.GetAddressBytes()[0] -ge 224) { return $false }
        # This is historical forwarding ownership, not the current transport address.
        # Callers first verify the current VM, disk chain and responding Core; DHCP may change its IP.
        $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp'
        $mapping = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'127.0.0.1/8123'
        return [bool]($mapping -and $mapping -ceq ([string]$receipt.address + '/' + [int]$receipt.port))
    } catch { return $false }
}

# Read-only discovery: do not start services or VMs, and do not trust a status file as endpoint evidence.
function Get-OwnedReadyEndpoint {
    $vm = Get-VM -Name 'RabiRoute-HomeAssistant' -ErrorAction Stop
    $diagnostics = @{ checkedAt = [DateTime]::UtcNow.ToString('o'); reason = 'vm_not_found'; guestAddresses = @() }
    if (-not $vm) { return @{ ready = $false; diagnostics = $diagnostics } }
    $disk = Join-Path $Root 'home-assistant.vhdx'
    $receipt = Join-Path $Root 'image.json'
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf) -or ((Get-Item -LiteralPath $receipt -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Managed HA installation receipt is missing or invalid.' }
    $attached = @(Get-VMHardDiskDrive -VM $vm)
    if ($vm.Notes -ne ('RabiRoute Home Assistant OS: ' + $Root) -or $attached.Count -ne 1 -or -not (Test-InstallationDisk $attached[0].Path $disk $true)) {
        throw 'A VM with this name is not owned by this installation.'
    }
    $diagnostics.vmState = [string]$vm.State
    if ($vm.State -ne 'Running') {
        $diagnostics.reason = 'vm_not_running'
        return @{ ready = $false; diagnostics = $diagnostics }
    }
    $addresses = @((Get-VMNetworkAdapter -VM $vm).IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127\.|169\.254\.|0\.)' } | Select-Object -First 8)
    $diagnostics.guestAddresses = @($addresses)
    $diagnostics.reason = if ($addresses.Count) { 'core_unready' } else { 'no_guest_address' }
    foreach ($address in $addresses) {
        foreach ($port in @(80, 8123)) {
            if (Test-HomeAssistantCore $address $port) {
                $diagnostics.reason = 'ready'
                return @{ ready = $true; address = $address; port = $port; vmId = [string]$vm.Id; legacyBindingVerified = (Test-OwnedLegacyLoopback $vm); diagnostics = $diagnostics }
            }
        }
    }
    return @{ ready = $false; diagnostics = $diagnostics }
}

function Wait-HomeAssistantCore($Vm, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $addresses = (Get-VMNetworkAdapter -VM $Vm).IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127\.|169\.254\.|0\.)' }
        foreach ($candidate in $addresses) {
            foreach ($port in @(80, 8123)) {
                if (Test-HomeAssistantCore $candidate $port) { return @{ address = $candidate; port = $port } }
            }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}


function Write-OperationResult([string]$Outcome, [string]$Code, [string]$Message, $Deferred = $null) {
    if ($script:operationResultEmitted) { throw 'Operation result was already emitted.' }
    $script:operationResultEmitted = $true
    $value = @{ schemaVersion = 1; operationId = $OperationId; action = $Operation; startedAt = $OperationStartedAt; completedAt = [DateTime]::UtcNow.ToString('o'); outcome = $Outcome; code = $Code; message = $Message; installed = $script:ownedVmVerified }
    if ($Deferred) { $value.deferred = $Deferred }
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Write-Output ('RABIROUTE_HA_RESULT:' + ($value | ConvertTo-Json -Compress))
}

function Get-StartMemoryAdmission($Vm) {
    $required = [long]$Vm.MemoryStartup
    $system = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    if ($required -le 0 -or $null -eq $system.FreePhysicalMemory -or [long]$system.FreePhysicalMemory -lt 0) { throw 'VM startup memory admission is unavailable.' }
    return @{ requiredMemoryBytes = $required; availableMemoryBytes = ([long]$system.FreePhysicalMemory * 1KB) }
}

function Get-StartMemoryErrorCode($Record) {
    # Inspect only this Start-VM failure, never the global UI status or an old log.
    $errorObject = $Record.Exception
    for ($depth = 0; $errorObject -and $depth -lt 8; $depth++) {
        if ($errorObject -is [ComponentModel.Win32Exception] -and $errorObject.NativeErrorCode -eq 1450) { return '0x800705AA' }
        if (([long]$errorObject.HResult -band 0xFFFF) -eq 1450) { return '0x800705AA' }
        if ($errorObject.Message -match '(?i)(?<![0-9a-f])0x800705aa(?![0-9a-f])') { return '0x800705AA' }
        $errorObject = $errorObject.InnerException
    }
    if ($Record.ErrorDetails -and $Record.ErrorDetails.Message -match '(?i)(?<![0-9a-f])0x800705aa(?![0-9a-f])') { return '0x800705AA' }
    return $null
}

function Start-OwnedHomeAssistantVm($Vm) {
    $memory = Get-StartMemoryAdmission $Vm
    if ($memory.availableMemoryBytes -lt $memory.requiredMemoryBytes) {
        return @{ started = $false; deferred = @{ reason = 'host_memory'; vmStarted = $false; requiredMemoryBytes = $memory.requiredMemoryBytes; availableMemoryBytes = $memory.availableMemoryBytes } }
    }
    Set-VM -VM $Vm -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
    try {
        Start-VM -VM $Vm -ErrorAction Stop | Out-Null
        return @{ started = $true }
    } catch {
        $code = Get-StartMemoryErrorCode $_
        if (-not $code) { throw }
        return @{ started = $false; deferred = @{ reason = 'host_memory'; vmStarted = $false; requiredMemoryBytes = $memory.requiredMemoryBytes; availableMemoryBytes = $memory.availableMemoryBytes; nativeCode = $code } }
    }
}

function Complete-DeferredStart($Deferred) {
    $message = if ($Deferred.reason -eq 'host_memory') {
        'Home Assistant 等待启动资源：需要 ' + [Math]::Ceiling($Deferred.requiredMemoryBytes / 1MB) + ' MiB，可用 ' + [Math]::Floor($Deferred.availableMemoryBytes / 1MB) + ' MiB；资源恢复后将自动重试。' + $(if ($Deferred.nativeCode) { ' ' + $Deferred.nativeCode } else { '' })
    } elseif ($Deferred.vmStarted) { 'Home Assistant 虚拟机已启动，正在等待网络和 Core 就绪；不会自动重启虚拟机。' }
    else { 'Home Assistant 虚拟机正在运行，等待 Core 就绪；不会自动重启或打断更新。' }
    Write-Status 'installed' $message
    Write-OperationResult 'deferred' $(if ($Deferred.reason -eq 'host_memory') { 'host_memory_wait' } else { 'core_starting' }) $message $Deferred
}

function Restore-HomeAssistantCore($Vm, [bool]$AllowRestart) {
    $address = Wait-HomeAssistantCore $Vm 90
    if ($address) { return $address }
    if (-not $AllowRestart) { return @{ deferred = @{ reason = 'core_starting'; vmStarted = $false } } }
    $job = Stop-VM -VM $Vm -AsJob
    try {
        $completed = Wait-Job -Job $job -Timeout 90
        if (-not $completed -or $completed.State -ne 'Completed') { throw 'Graceful HA VM shutdown did not complete; forced shutdown is forbidden.' }
        Receive-Job -Job $job -ErrorAction Stop | Out-Null
        $current = Get-VM -Id $Vm.Id
        if ($current.State -ne 'Off') { throw 'HA VM did not stop; it was not reset.' }
        $start = Start-OwnedHomeAssistantVm $current
        if ($start.deferred) { return @{ deferred = $start.deferred } }
    } finally {
        if ($job.State -in @('Completed', 'Failed', 'Stopped')) { Remove-Job -Job $job }
    }
    $address = Wait-HomeAssistantCore $Vm 180
    if (-not $address) { throw 'Home Assistant Core did not become ready after one graceful VM restart.' }
    return $address
}

$administrator = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $administrator) {
    throw 'Administrator approval is required at Rabi Host startup. HA automatic recovery and port forwarding are unavailable in limited mode.'
}

$mutex = [Threading.Mutex]::new($false, 'Global\RabiRoute.HomeAssistantOs.Install')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        if ($Operation -eq 'Observe') { Write-Output 'RABIROUTE_HA_OBSERVATION:{"ready":false}' }
        return
    }
    if ($Operation -ne 'Observe') {
        foreach ($item in Get-ChildItem -LiteralPath $Root -Force -Recurse) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation files cannot contain reparse points.' }
        }
    }
    if ($Operation -eq 'Observe') {
        Import-Module Hyper-V
        $service = Get-Service vmms -ErrorAction SilentlyContinue
        $result = if ($service -and $service.Status -eq 'Running') { Get-OwnedReadyEndpoint } else { $null }
        if (-not $result) { $result = @{ ready = $false } }
        Write-Output ('RABIROUTE_HA_OBSERVATION:' + ($result | ConvertTo-Json -Compress))
        return
    }
    Write-Status 'installing' '正在检查 Hyper-V。' '' 'check'
    $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
    if ($feature.State -ne 'Enabled') {
        if ($Operation -ne 'Install') { throw 'Hyper-V is not enabled. Use Install first.' }
        if ($feature.State -ne 'EnablePending') {
            Write-Status 'installing' '正在启用 Hyper-V，请勿关闭电脑。' '' 'enable-hyper-v'
            Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
        }
        Write-Status 'reboot_required' 'Hyper-V 已请求启用。请保存工作并手动重启 Windows，重启后再次点击安装继续。'
        Write-OperationResult 'reboot_required' 'hyperv_reboot_required' 'Hyper-V 启用后需要重启 Windows。'
        return
    }
    Import-Module Hyper-V
    if ((Get-Service vmms).Status -ne 'Running') { Start-Service vmms }
    $vmName = 'RabiRoute-HomeAssistant'
    $owner = 'RabiRoute Home Assistant OS: ' + $Root
    $disk = Join-Path $Root 'home-assistant.vhdx'
    $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
    if ($vm) {
        $attachedDisks = @(Get-VMHardDiskDrive -VM $vm)
        if ($vm.Notes -ne $owner -or $attachedDisks.Count -ne 1 -or -not (Test-InstallationDisk $attachedDisks[0].Path $disk)) {
            throw 'A VM with this name already exists and is not owned by this installation. It was not changed.'
        }
    }
    $version = ''
    if (-not $vm) {
        if ($Operation -ne 'Install') { throw 'Home Assistant OS is not installed. Use Install first.' }
        $switch = Get-VMSwitch | Where-Object { $_.SwitchType -eq 'Internal' -and $_.Name -in @('Default Switch', '默认交换机', '默认开关') } | Select-Object -First 1
        if (-not $switch) { throw 'Hyper-V Default Switch is unavailable. Restart Windows and retry.' }
        $imageReceipt = Join-Path $Root 'image.json'
        if (-not (Test-Path -LiteralPath $disk)) {
            if ($drive.FreeSpace -lt 40GB) { throw 'At least 40 GiB of free space is required on the installation disk.' }
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Write-Status 'installing' '正在查询 Home Assistant 官方稳定版镜像。' '' 'release'
            $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/home-assistant/operating-system/releases/latest' -Headers @{ 'User-Agent' = 'RabiRoute-HomeAssistant-Setup' } -TimeoutSec 30
            if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^\d+\.\d+(\.\d+)?$') { throw 'Invalid stable HA OS release.' }
            $assets = @($release.assets | Where-Object { $_.name -match '^haos_ova-[0-9.]+\.vhdx\.zip$' })
            if ($assets.Count -ne 1) { throw 'Official Hyper-V image was not found.' }
            $asset = $assets[0]
            $version = [string]$release.tag_name
            $expectedUrl = 'https://github.com/home-assistant/operating-system/releases/download/' + $version + '/' + $asset.name
            if ($asset.browser_download_url -cne $expectedUrl -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$' -or $asset.size -gt 4GB) { throw 'Official image URL or checksum is invalid.' }
            $archive = Join-Path $Root 'download.zip'
            Save-ImageDownload $expectedUrl $archive ([long]$asset.size) $version
            Write-Status 'installing' '正在校验镜像 SHA256。' $version 'verify'
            if ((Get-Item -LiteralPath $archive).Length -ne $asset.size -or ('sha256:' + (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $asset.digest) { throw 'Image checksum verification failed. No VM was created.' }
            Write-Status 'installing' '镜像校验通过，正在解压。' $version 'extract'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $entries = @($zip.Entries | Where-Object { $_.FullName -match '^haos_ova-[0-9.]+\.vhdx$' })
                if ($entries.Count -ne 1 -or $entries[0].Length -gt 40GB) { throw 'Invalid VHDX archive.' }
                $partial = Join-Path $Root ('disk-' + [guid]::NewGuid().ToString('N') + '.partial')
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $partial, $false)
                $receipt = @{ version = $version; archiveSha256 = $asset.digest; diskSha256 = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash }
                [IO.File]::WriteAllText($imageReceipt, ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
                [IO.File]::Move($partial, $disk)
            } finally { $zip.Dispose() }
        } else {
            if (-not (Test-Path -LiteralPath $imageReceipt)) { throw 'Existing disk has no installation receipt; it was not overwritten.' }
            $receipt = Get-Content -LiteralPath $imageReceipt -Raw | ConvertFrom-Json
            if ((Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash -cne $receipt.diskSha256) { throw 'Existing disk differs from the verified image; it was not overwritten.' }
            $version = $receipt.version
        }
        Write-Status 'installing' '正在创建 Home Assistant OS 虚拟机。' $version 'create-vm'
        $vm = New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 2GB -VHDPath $disk -Path (Join-Path $Root 'vm') -SwitchName $switch.Name
        Set-VM -VM $vm -Notes $owner
        Set-VMProcessor -VM $vm -Count 2
        Set-VMFirmware -VM $vm -EnableSecureBoot Off
    }
    $script:ownedVmVerified = $true
    $wasRunning = $vm.State -eq 'Running'
    $vmStarted = $false
    # Automatic Start observes a running owner without rewriting VM settings or restarting it.
    if ($wasRunning -and $Operation -eq 'Start') {
        $observed = Get-OwnedReadyEndpoint
        if ($observed.ready) {
            Write-Status 'installed' 'Home Assistant OS 与 Core 已就绪。' $version
            Write-Output ('RABIROUTE_HA_ENDPOINT:' + (@{ address = $observed.address; port = $observed.port; vmId = [string]$vm.Id; legacyBindingVerified = $observed.legacyBindingVerified } | ConvertTo-Json -Compress))
            Write-OperationResult 'ready' 'core_ready' 'Home Assistant OS 与 Core 已就绪。'
        } else { Complete-DeferredStart @{ reason = 'core_starting'; vmStarted = $false } }
        return
    }
    if ($vm.State -eq 'Off') {
        $start = Start-OwnedHomeAssistantVm $vm
        if ($start.deferred) { Complete-DeferredStart $start.deferred; return }
        $vmStarted = $true
    }
    elseif ($vm.State -ne 'Running') { throw 'The VM is in a state that needs manual attention; it was not reset.' }
    Write-Status 'installing' '虚拟机已启动，正在等待网络地址。' $version 'network'
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    $address = $null
    do {
        $address = (Get-VMNetworkAdapter -VM $vm).IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127\.|169\.254\.|0\.)' } | Select-Object -First 1
        if (-not $address) { Start-Sleep -Seconds 2 }
    } while (-not $address -and [DateTime]::UtcNow -lt $deadline)
    if (-not $address) { Complete-DeferredStart @{ reason = 'core_starting'; vmStarted = $vmStarted }; return }
    Write-Status 'installing' '正在等待 Home Assistant Core 就绪；自动启动不会重启虚拟机。' $version 'core-health'
    $endpoint = Restore-HomeAssistantCore $vm ($wasRunning -and $Operation -eq 'Recover')
    if ($endpoint.deferred) { if ($vmStarted) { $endpoint.deferred.vmStarted = $true }; Complete-DeferredStart $endpoint.deferred; return }
    Write-Status 'installed' 'Home Assistant OS 与 Core 已就绪。' $version
    Write-Output ('RABIROUTE_HA_ENDPOINT:' + (@{ address = $endpoint.address; port = $endpoint.port; vmId = [string]$vm.Id; legacyBindingVerified = (Test-OwnedLegacyLoopback $vm) } | ConvertTo-Json -Compress))
    Write-OperationResult 'ready' 'core_ready' 'Home Assistant OS 与 Core 已就绪。'
} catch {
    if ($Operation -eq 'Observe') { exit 1 }
    $message = '操作未完成：' + $_.Exception.Message
    Write-Status 'error' $message
    Write-OperationResult 'failed' 'operation_failed' $message
    exit 0
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

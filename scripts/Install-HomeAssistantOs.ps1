param(
    [ValidateSet('Install', 'Start')][string]$Operation = 'Install',
    [Parameter(Mandatory = $true)][string]$Root,
    [ValidateSet('yes', 'no')][string]$AutoStart = 'no'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = [IO.Path]::GetFullPath($Root)
if ($Root.StartsWith('\\') -or $Root.Contains('"')) { throw 'Installation requires a local directory.' }
$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$([IO.Path]::GetPathRoot($Root).TrimEnd('\'))'"
if (-not $drive -or $drive.DriveType -ne 3) { throw 'Installation requires a fixed local disk.' }
for ($parent = $Root; $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths cannot contain reparse points.' }
}
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$statusPath = Join-Path $Root 'status.json'
function Write-Status([string]$State, [string]$Message, [string]$Version = '') {
    $value = @{ state = $State; message = $Message; version = $Version; root = $Root; updatedAt = [DateTime]::UtcNow.ToString('o') }
    $temporary = Join-Path $Root ('status-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $statusPath) { [IO.File]::Replace($temporary, $statusPath, (Join-Path $Root 'status.previous.json')) }
    else { [IO.File]::Move($temporary, $statusPath) }
}

$administrator = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $administrator) {
    # Elevate only this fixed installer and its bounded arguments, never an HTTP-supplied command.
    $command = "& '" + $PSCommandPath.Replace("'", "''") + "' -Operation '" + $Operation + "' -Root '" + $Root.Replace("'", "''") + "' -AutoStart '" + $AutoStart + "'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($child.ExitCode -ne 0) { throw 'Elevated installer failed.' }
    } catch { Write-Status 'error' '管理员授权未完成或安装器未能启动。请再次点击安装并确认 Windows 提示。' }
    exit
}

$mutex = [Threading.Mutex]::new($false, 'Global\RabiRoute.HomeAssistantOs.Install')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force -Recurse) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation files cannot contain reparse points.' }
    }
    Write-Status 'installing' '正在检查 Hyper-V。'
    $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
    if ($feature.State -ne 'Enabled') {
        if ($Operation -ne 'Install') { throw 'Hyper-V is not enabled. Use Install first.' }
        if ($feature.State -ne 'EnablePending') {
            Write-Status 'installing' '正在启用 Hyper-V，请勿关闭电脑。'
            Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
        }
        Write-Status 'reboot_required' 'Hyper-V 已请求启用。请保存工作并手动重启 Windows，重启后再次点击安装继续。'
        return
    }
    Import-Module Hyper-V
    if ((Get-Service vmms).Status -ne 'Running') { Start-Service vmms }
    $vmName = 'RabiRoute-HomeAssistant'
    $owner = 'RabiRoute Home Assistant OS: ' + $Root
    $disk = Join-Path $Root 'home-assistant.vhdx'
    $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
    if ($vm -and ($vm.Notes -ne $owner -or @((Get-VMHardDiskDrive -VM $vm) | Where-Object Path -eq $disk).Count -ne 1)) {
        throw 'A VM with this name already exists and is not owned by this installation. It was not changed.'
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
            Write-Status 'installing' '正在查询 Home Assistant 官方稳定版镜像。'
            $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/home-assistant/operating-system/releases/latest' -Headers @{ 'User-Agent' = 'RabiRoute-HomeAssistant-Setup' } -TimeoutSec 30
            if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^\d+\.\d+(\.\d+)?$') { throw 'Invalid stable HA OS release.' }
            $assets = @($release.assets | Where-Object { $_.name -match '^haos_ova-[0-9.]+\.vhdx\.zip$' })
            if ($assets.Count -ne 1) { throw 'Official Hyper-V image was not found.' }
            $asset = $assets[0]
            $version = [string]$release.tag_name
            $expectedUrl = 'https://github.com/home-assistant/operating-system/releases/download/' + $version + '/' + $asset.name
            if ($asset.browser_download_url -cne $expectedUrl -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$' -or $asset.size -gt 4GB) { throw 'Official image URL or checksum is invalid.' }
            $archive = Join-Path $Root 'download.zip'
            Write-Status 'installing' '正在下载 Home Assistant OS，首次下载可能需要较长时间。' $version
            Invoke-WebRequest -UseBasicParsing -Uri $expectedUrl -OutFile $archive -TimeoutSec 1200
            if ((Get-Item -LiteralPath $archive).Length -ne $asset.size -or ('sha256:' + (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $asset.digest) { throw 'Image checksum verification failed. No VM was created.' }
            Write-Status 'installing' '镜像校验通过，正在解压。' $version
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
        Write-Status 'installing' '正在创建 Home Assistant OS 虚拟机。' $version
        $vm = New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 2GB -VHDPath $disk -Path (Join-Path $Root 'vm') -SwitchName $switch.Name
        Set-VM -VM $vm -Notes $owner
        Set-VMProcessor -VM $vm -Count 2
        Set-VMFirmware -VM $vm -EnableSecureBoot Off
    }
    Set-VM -VM $vm -AutomaticStartAction $(if ($AutoStart -eq 'yes') { 'Start' } else { 'Nothing' }) -AutomaticStopAction ShutDown
    if ($vm.State -eq 'Off') { Start-VM -VM $vm }
    elseif ($vm.State -ne 'Running') { throw 'The VM is in a state that needs manual attention; it was not reset.' }
    Write-Status 'installing' '虚拟机已启动，正在等待网络地址。' $version
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    $address = $null
    do {
        $address = (Get-VMNetworkAdapter -VM $vm).IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127\.|169\.254\.|0\.)' } | Select-Object -First 1
        if (-not $address) { Start-Sleep -Seconds 2 }
    } while (-not $address -and [DateTime]::UtcNow -lt $deadline)
    if (-not $address) { throw 'VM network address is not ready. Use Start and check later; the VM was preserved.' }
    $proxyReceipt = Join-Path $Root 'loopback-proxy.json'
    $proxyKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp'
    $existing = (Get-ItemProperty -LiteralPath $proxyKey -ErrorAction SilentlyContinue).'127.0.0.1/8123'
    $previous = if (Test-Path -LiteralPath $proxyReceipt) { Get-Content -LiteralPath $proxyReceipt -Raw | ConvertFrom-Json } else { $null }
    if ($existing -and (-not $previous -or $existing -ne ($previous.address + '/8123'))) { throw 'Local port 8123 has another port-proxy owner; it was not changed.' }
    if (-not $existing -and (Get-NetTCPConnection -State Listen -LocalPort 8123 -ErrorAction SilentlyContinue)) { throw 'Local port 8123 is already occupied; it was not changed.' }
    # Only publish to local loopback. No firewall rule, LAN exposure or credential policy changes.
    Start-Service iphlpsvc
    & netsh.exe interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8123 connectaddress=$address connectport=8123 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the loopback endpoint.' }
    [IO.File]::WriteAllText($proxyReceipt, (@{ address = $address; vmId = [string]$vm.Id } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Write-Status 'installed' 'Home Assistant OS 已安装并启动。首次初始化仍可能需要几分钟，随后点击重新检测。' $version
} catch {
    Write-Status 'error' ('安装未完成：' + $_.Exception.Message)
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

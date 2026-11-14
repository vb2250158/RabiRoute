# Shared by the two existing scheduled-task owners. No listener or extra supervisor lives here.
function Initialize-RelayServiceOwner {
    param([string]$Root, [string]$Role)
    if (-not ('RabiRelayServiceJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RabiRelayServiceJob {
    static IntPtr job;
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public Io io; public UIntPtr a,b,c,d; }
    public static void Enter() {
        if (job != IntPtr.Zero) return;
        job=CreateJobObject(IntPtr.Zero,null);
        if(job==IntPtr.Zero) throw new Win32Exception();
        var limits=new Extended(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
        int size=Marshal.SizeOf(limits); IntPtr data=Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(limits,data,false);
            if(!SetInformationJobObject(job,9,data,(uint)size) || !AssignProcessToJobObject(job,GetCurrentProcess())) throw new Win32Exception();
        } finally { Marshal.FreeHGlobal(data); }
        // Keep the handle until owner exit. Children inherit the job at creation, without an assignment race.
    }
}
'@
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Root).ToLowerInvariant()))).Replace('-', '') }
    finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Global\RabiLink-$Role-$key")
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { $mutex.Dispose(); throw "The $Role owner is already running for this service root." }
    try { [RabiRelayServiceJob]::Enter() } catch { $mutex.ReleaseMutex(); $mutex.Dispose(); throw }
    return $mutex
}

function Test-RelayEntryPoint {
    param([string]$CommandLine, [string]$ExpectedPath, [ValidateSet('powershell','node','caddy')][string]$Kind, [switch]$ArgumentsOnly, [switch]$Strict)
    if (-not ('RabiRelayCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RabiRelayCommandLine {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string c, out int n);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    public static string[] Split(string command) {
        int count; IntPtr block=CommandLineToArgvW(command,out count);
        if(block==IntPtr.Zero) throw new Win32Exception();
        try { var args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(block,i*IntPtr.Size)); return args; }
        finally { LocalFree(block); }
    }
}
'@
    }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    if ($ArgumentsOnly) { $CommandLine = 'relay-owner.exe ' + $CommandLine }
    $arguments = [RabiRelayCommandLine]::Split($CommandLine)
    $entry = $null
    if ($Kind -eq 'powershell') {
        for ($index=1; $index -lt $arguments.Length; $index++) {
            $option = $arguments[$index].ToLowerInvariant()
            if ($option -in @('-noprofile','-nologo','-noninteractive','-sta','-mta')) { continue }
            if ($option -eq '-executionpolicy') {
                $index++
                if ($index -ge $arguments.Length -or $arguments[$index] -notin @('Bypass','RemoteSigned','AllSigned','Restricted','Unrestricted','Default','Undefined')) { return $false }
                continue
            }
            if ($option -ne '-file' -or $index+1 -ge $arguments.Length) { return $false }
            $entry = $arguments[$index+1]
            if ($Strict -and $index+2 -ne $arguments.Length) { return $false }
            break
        }
    } elseif ($Kind -eq 'node') {
        for ($index=1; $index -lt $arguments.Length; $index++) {
            if ($arguments[$index] -in @('--enable-source-maps','--no-warnings','--trace-warnings','--trace-uncaught','--unhandled-rejections=strict')) { continue }
            if ($arguments[$index] -eq '--') { $index++; if ($index -lt $arguments.Length) { $entry=$arguments[$index] }; break }
            if ($arguments[$index].StartsWith('-')) { return $false }
            $entry=$arguments[$index]; break
        }
    } else {
        if ($arguments.Length -ne 4 -or $arguments[1] -ne 'run' -or $arguments[2] -ne '--config') { return $false }
        $entry=$arguments[3]
    }
    if (-not $entry -or -not [IO.Path]::IsPathRooted($entry)) { return $false }
    try { return [IO.Path]::GetFullPath($entry) -eq [IO.Path]::GetFullPath($ExpectedPath) }
    catch { return $false }
}

function Assert-RelayScheduledTaskRoot {
    param($Task, [string]$Root, [string]$Launcher)
    if ($null -eq $Task) { return }
    $action = @($Task.Actions | Where-Object {
        [IO.Path]::GetFileName($_.Execute) -in @('powershell.exe', 'pwsh.exe') -and
        (Test-RelayEntryPoint -CommandLine $_.Arguments -ExpectedPath (Join-Path $Root $Launcher) -Kind powershell -ArgumentsOnly -Strict)
    })
    if ($action.Count -ne 1 -or @($Task.Actions).Count -ne 1) { throw 'Scheduled task belongs to a different service owner; migration stopped.' }
}

function Stop-RelayServiceProcesses {
    param([string]$Root, [ValidateSet('relay', 'caddy')][string]$Role)
    $launcher = Join-Path $Root $(if ($Role -eq 'relay') { 'start-rabilink-relay.ps1' } else { 'start-caddy.ps1' })
    $entry = Join-Path $Root 'scripts/rabilink-relay-server.mjs'
    $legacyEntry = Join-Path $Root 'rabilink-relay-server.mjs'
    $config = Join-Path $Root 'Caddyfile'
    $handles = @()
    foreach ($snapshot in @(Get-CimInstance Win32_Process)) {
        $isOwner = $snapshot.Name -in @('powershell.exe', 'pwsh.exe') -and (Test-RelayEntryPoint $snapshot.CommandLine $launcher powershell)
        $isChild = if ($Role -eq 'relay') {
            $snapshot.Name -eq 'node.exe' -and ((Test-RelayEntryPoint $snapshot.CommandLine $entry node) -or (Test-RelayEntryPoint $snapshot.CommandLine $legacyEntry node))
        } else { $snapshot.Name -eq 'caddy.exe' -and (Test-RelayEntryPoint $snapshot.CommandLine $config caddy) }
        if (-not ($isOwner -or $isChild)) { continue }
        try { $process = [Diagnostics.Process]::GetProcessById([int]$snapshot.ProcessId) } catch [ArgumentException] { continue }
        try {
            if ($process.HasExited) { $process.Dispose(); continue }
            if ($process.StartTime.ToUniversalTime().ToString("yyyyMMddHHmmss.ffffff") -ne ([DateTime]$snapshot.CreationDate).ToUniversalTime().ToString("yyyyMMddHHmmss.ffffff")) { $process.Dispose(); continue }
        } catch [InvalidOperationException] {
            if ($process.HasExited) { $process.Dispose(); continue }
            $process.Dispose(); throw
        }
        $handles += $process
    }
    try {
        foreach ($process in $handles) { Stop-RelayOwnedChild $process }
    } finally { foreach ($process in $handles) { $process.Dispose() } }
}

function Write-RelayEndpoint {
    param([string]$Root, $Endpoint)
    $destination = Join-Path $Root 'logs/relay-endpoint.json'
    $temporary = "$destination.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Endpoint | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    try {
        if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Get-RelayEndpoint {
    param([string]$Root)
    try {
        $endpoint = Get-Content -LiteralPath (Join-Path $Root 'logs/relay-endpoint.json') -Raw | ConvertFrom-Json
        if ($endpoint.state -ne 'ready' -or $endpoint.host -ne '127.0.0.1' -or $endpoint.port -lt 1 -or $endpoint.port -gt 65535) { return $null }
        $entry = Join-Path $Root 'scripts/rabilink-relay-server.mjs'
        if ($endpoint.entry -ne $entry) { return $null }
        $owner = $null; $child = $null
        try {
            $owner = [Diagnostics.Process]::GetProcessById([int]$endpoint.ownerPid)
            $child = [Diagnostics.Process]::GetProcessById([int]$endpoint.pid)
            if ($owner.StartTime.ToUniversalTime().Ticks.ToString() -ne $endpoint.ownerStart -or $child.StartTime.ToUniversalTime().Ticks.ToString() -ne $endpoint.start) { return $null }
            $snapshot = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
            if ($snapshot.ParentProcessId -ne $owner.Id -or $snapshot.ExecutablePath -ne $endpoint.executable -or -not (Test-RelayEntryPoint $snapshot.CommandLine $entry node)) { return $null }
            if (-not (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $endpoint.port -State Listen -ErrorAction Stop | Where-Object OwningProcess -eq $child.Id)) { return $null }
            return $endpoint
        } finally { if ($owner) { $owner.Dispose() }; if ($child) { $child.Dispose() } }
    } catch { return $null }
}

function Stop-RelayOwnedChild {
    param([Diagnostics.Process]$Process)
    if ($null -eq $Process) { return }
    if (-not $Process.HasExited) {
        try { $Process.Kill() }
        catch [InvalidOperationException] { if (-not $Process.HasExited) { throw } }
    }
    if (-not $Process.WaitForExit(10000)) { throw 'Owned service child did not exit; replacement is fenced.' }
}

function Start-RelayServiceOwner {
    param([string]$Root, [switch]$Once)
    $ErrorActionPreference = 'Stop'
    Set-Location -LiteralPath $Root
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
    $mutex = Initialize-RelayServiceOwner $Root 'relay'
    $process = $null
    try {
        $entry = Join-Path $Root 'scripts/rabilink-relay-server.mjs'
        # A legacy orphan is not authority to create a second state writer. Deployment owns its migration.
        $legacyEntry = Join-Path $Root 'rabilink-relay-server.mjs'
        if (Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { (Test-RelayEntryPoint $_.CommandLine $entry node) -or (Test-RelayEntryPoint $_.CommandLine $legacyEntry node) }) { throw 'An earlier Relay child still exists for this root.' }
        do {
            $run = [Guid]::NewGuid().ToString('N')
            Write-RelayEndpoint $Root @{state='starting'; run=$run}
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = (Get-Command node.exe -ErrorAction Stop).Source
            $info.Arguments = '"' + $entry + '"'
            $info.WorkingDirectory = $Root
            $info.UseShellExecute = $false; $info.CreateNoWindow = $true
            $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
            foreach ($name in @('PORT','RABILINK_RELAY_PORT')) { $info.EnvironmentVariables[$name] = '0' }
            foreach ($name in @('HOST','RABILINK_RELAY_HOST')) { $info.EnvironmentVariables[$name] = '127.0.0.1' }
            $info.EnvironmentVariables['RABILINK_RELAY_DATA_DIR'] = Join-Path $Root 'data'
            $info.EnvironmentVariables.Remove('RABILINK_RELAY_TOKEN')
            $process = New-Object Diagnostics.Process; $process.StartInfo = $info
            [void]$process.Start()
            $stdout = $process.StandardOutput.ReadLineAsync(); $stderr = $process.StandardError.ReadLineAsync()
            $deadline = [DateTime]::UtcNow.AddSeconds(30); $ready = $false
            while (-not $process.HasExited -or $null -ne $stdout -or $null -ne $stderr) {
                foreach ($stream in @('stdout','stderr')) {
                    $pending = Get-Variable -Name $stream -ValueOnly
                    if ($null -eq $pending -or -not $pending.IsCompleted) { continue }
                    $line = $pending.GetAwaiter().GetResult()
                    $next = $null
                    if ($null -ne $line) {
                        Add-Content -LiteralPath (Join-Path $Root 'logs/rabilink-relay.log') -Value $line
                        if ($stream -eq 'stdout' -and $line.StartsWith('RABILINK_RELAY_READY:')) {
                            $actual = $line.Substring('RABILINK_RELAY_READY:'.Length) | ConvertFrom-Json
                            if ($actual.pid -ne $process.Id -or $actual.host -ne '127.0.0.1' -or $actual.port -lt 1 -or $actual.port -gt 65535 -or $process.HasExited) { throw 'Invalid READY from original Relay child.' }
                            $self = [Diagnostics.Process]::GetCurrentProcess()
                            try { $publication = @{state='ready'; run=$run; pid=$process.Id; start=$process.StartTime.ToUniversalTime().Ticks.ToString(); ownerPid=$PID; ownerStart=$self.StartTime.ToUniversalTime().Ticks.ToString(); executable=$info.FileName; entry=$entry; host='127.0.0.1'; port=[int]$actual.port} }
                            finally { $self.Dispose() }
                            Write-RelayEndpoint $Root $publication
                            if (-not (Get-RelayEndpoint $Root)) { throw 'Relay READY has no matching live owned listener.' }
                            $ready = $true
                        }
                        $reader = if ($stream -eq 'stdout') { $process.StandardOutput } else { $process.StandardError }
                        $next = $reader.ReadLineAsync()
                    }
                    Set-Variable -Name $stream -Value $next
                }
                if (-not $ready -and [DateTime]::UtcNow -gt $deadline) { throw 'Original Relay child did not publish READY before the startup deadline.' }
                Start-Sleep -Milliseconds 50
            }
            $process.WaitForExit()
            Write-RelayEndpoint $Root @{state='unavailable'; run=$run}
            $process.Dispose(); $process=$null
            if (-not $Once) { Start-Sleep -Seconds 3 }
        } while (-not $Once)
    } finally {
        try { Write-RelayEndpoint $Root @{state='unavailable'} }
        finally {
            try { Stop-RelayOwnedChild $process }
            finally { if ($process) { $process.Dispose() }; $mutex.ReleaseMutex(); $mutex.Dispose() }
        }
    }
}

function Test-RelayLegacyUpstream {
    param([string]$Token)
    $value = $Token.Trim('"', [char]96)
    $value = $value -replace '^(?:tcp|tcp4|tcp6)/', ''
    if ($value -notmatch '^[a-z][a-z0-9+.-]*://') { $value = 'http://' + $value }
    try { $target = [Uri]$value } catch { return $false }
    if (-not $target.IsAbsoluteUri -or $target.Port -ne 8788) { return $false }
    $hostname = $target.Host.Trim('[',']').TrimEnd('.')
    if ($hostname -eq 'localhost') { return $true }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($hostname, [ref]$address)) { return $false }
    if ($address.IsIPv4MappedToIPv6) { $address=$address.MapToIPv4() }
    return [Net.IPAddress]::IsLoopback($address) -or $address.Equals([Net.IPAddress]::Any) -or $address.Equals([Net.IPAddress]::IPv6Any)
}

function Assert-NoRelayLegacyUpstream {
    param([string]$Content)
    foreach ($placeholder in [regex]::Matches($Content, '\{\$[A-Za-z_][A-Za-z0-9_]*:(?<default>[^}]*)\}')) {
        if (Test-RelayLegacyUpstream $placeholder.Groups['default'].Value) { throw 'Caddy environment defaults still contain a local legacy upstream.' }
    }
    foreach ($token in [regex]::Matches($Content, '[^\s{}]+:0*8788[^\s{}]*')) {
        if (Test-RelayLegacyUpstream $token.Value) { throw 'Caddy template still contains an unmigrated local legacy upstream.' }
    }
}

function ConvertTo-RelayCaddyTemplate {
    param([string]$Content)
    # Imports and unknown managed bodies need an explicit migration: never evaluate their environment or guess their expansion.
    if ($Content.Contains('{$')) { throw 'Caddy environment substitutions require explicit migration; original configuration was preserved.' }
    if ($Content -match '(?m)^\s*(?:import|"import"|`import`)\s+') { throw 'Caddy imports require explicit migration; original configuration was preserved.' }
    $route = '/(?:health|rokid/rabilink\*|api/rabilink/\*|openapi\*|share/\*|worker/\*|manage\*)'
    $headers = [regex]::Matches($Content, '(?m)(?:handle|"handle"|`handle`)\s+(?:' + $route + '|"' + $route + '"|`' + $route + '`)\s*\{')
    if ($headers.Count -eq 0) { throw 'No original managed Caddy routes were found.' }
    $replacements = @()
    foreach ($header in $headers) {
        $start = $header.Index + $header.Length
        $closing = $Content.IndexOf('}', $start)
        if ($closing -lt 0) { throw 'An original managed Caddy route has no closing brace.' }
        $body = $Content.Substring($start, $closing-$start)
        $simple = [regex]::Match($body, '\A(?<before>\s*reverse_proxy\s+)(?<upstream>[^\s{}]+)(?<after>\s*)\z')
        if (-not $simple.Success) { throw 'A managed Caddy route has an unknown body or upstream; explicit migration is required.' }
        $upstream = $simple.Groups['upstream'].Value
        if ($upstream -eq '__RABILINK_RELAY_UPSTREAM__') { continue }
        if (-not (Test-RelayLegacyUpstream $upstream) -or $upstream -match '@|^(?:https|h2c)://') { throw 'A managed Caddy upstream requires explicit migration; original configuration was preserved.' }
        $replacements += @{start=$start; length=$body.Length; value=$simple.Groups['before'].Value+'__RABILINK_RELAY_UPSTREAM__'+$simple.Groups['after'].Value}
    }
    $template = $Content
    foreach ($replacement in ($replacements | Sort-Object start -Descending)) {
        $template = $template.Remove($replacement.start, $replacement.length).Insert($replacement.start, $replacement.value)
    }
    Assert-NoRelayLegacyUpstream $template
    if ($template -notmatch '(?m)^\s*admin\s+') {
        if ($template -match '\A\s*\{') { $template = [regex]::Replace($template, '\A\s*\{', "{`r`n    admin off", 1) }
        else { $template = "{`r`n    admin off`r`n}`r`n" + $template }
    }
    return $template
}

function Start-RelayCaddyOwner {
    param([string]$Root, [string]$Executable = 'C:\caddy\caddy.exe', [string]$ArgumentPrefix = '', [switch]$Once)
    $ErrorActionPreference = 'Stop'
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
    $mutex = Initialize-RelayServiceOwner $Root 'caddy'
    $process = $null; $run = $null
    $watcher = New-Object IO.FileSystemWatcher((Join-Path $Root 'logs'), 'relay-endpoint.json')
    try {
        $configPath = Join-Path $Root 'Caddyfile'
        if (Get-CimInstance Win32_Process -Filter "name = 'caddy.exe'" | Where-Object { Test-RelayEntryPoint $_.CommandLine $configPath caddy }) { throw 'An earlier Caddy child still exists for this root.' }
        $template = ConvertTo-RelayCaddyTemplate (Get-Content -LiteralPath (Join-Path $Root 'Caddyfile.template') -Raw)
        if (-not $template.Contains('__RABILINK_RELAY_UPSTREAM__')) { throw 'Caddy template has no managed Relay upstream.' }
        do {
            $endpoint = Get-RelayEndpoint $Root
            if ($null -ne $process -and ($process.HasExited -or $null -eq $endpoint -or $endpoint.run -ne $run)) {
                Stop-RelayOwnedChild $process; $process.Dispose(); $process=$null; $run=$null
                if ($Once) { break }
            }
            if ($null -eq $process -and $null -ne $endpoint) {
                $config = Join-Path $Root 'Caddyfile'
                [IO.File]::WriteAllText($config, $template.Replace('__RABILINK_RELAY_UPSTREAM__', "127.0.0.1:$($endpoint.port)"), (New-Object Text.UTF8Encoding($false)))
                $arguments = ($ArgumentPrefix + ' run --config "' + $config + '"').Trim()
                $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $Root 'logs/caddy.stdout.log') -RedirectStandardError (Join-Path $Root 'logs/caddy.stderr.log') -WindowStyle Hidden -PassThru
                $run = $endpoint.run
                Add-Content -LiteralPath (Join-Path $Root 'logs/caddy-supervisor.log') -Value "$(Get-Date -Format o) forwarding Relay generation $run on port $($endpoint.port)"
            }
            # The existing Caddy owner reacts to endpoint changes and revalidates the original listener identity.
            [void]$watcher.WaitForChanged([IO.WatcherChangeTypes]::All, 1000)
        } while ($true)
    } finally { $watcher.Dispose(); Stop-RelayOwnedChild $process; if ($process) { $process.Dispose() }; $mutex.ReleaseMutex(); $mutex.Dispose() }
}

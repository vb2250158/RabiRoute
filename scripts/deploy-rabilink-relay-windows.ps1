param(
    [string]$ServerIp = "",
    [string]$Username = "Administrator",
    [string]$KeyPath = "",
    [string]$Domain = "",
    [string]$RemoteRoot = "C:\opt\rabilink-relay",
    [string]$CaddyVersion = "2.8.4",
    [int]$PublicHttpPort = 0
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot "data\rabilink-relay\config.json"
$relayConfig = $null
if (Test-Path -LiteralPath $configPath) {
    $relayConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Get-ConfigString {
    param(
        [object]$Config,
        [string]$Name
    )

    if ($null -eq $Config) {
        return ""
    }
    $property = $Config.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }
    return [string]$property.Value
}

if ([string]::IsNullOrWhiteSpace($ServerIp)) {
    $ServerIp = Get-ConfigString -Config $relayConfig -Name "serverIp"
}
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
    $KeyPath = Get-ConfigString -Config $relayConfig -Name "sshKeyPath"
}
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
    $KeyPath = "$HOME\.ssh\id_ed25519"
}
if ([string]::IsNullOrWhiteSpace($Domain)) {
    $Domain = Get-ConfigString -Config $relayConfig -Name "publicHost"
}
if ([string]::IsNullOrWhiteSpace($Domain)) {
    $publicBaseUrl = Get-ConfigString -Config $relayConfig -Name "publicBaseUrl"
    if (-not [string]::IsNullOrWhiteSpace($publicBaseUrl)) {
        $Domain = ([Uri]$publicBaseUrl).Host
    }
}
if ([string]::IsNullOrWhiteSpace($ServerIp)) {
    throw "ServerIp is required. Pass -ServerIp <public-ip-or-host>."
}
if ([string]::IsNullOrWhiteSpace($Domain)) {
    throw "Domain is required. Pass -Domain <public-domain> or set data\rabilink-relay\config.json publicBaseUrl/publicHost."
}
function Invoke-RemotePowerShell {
    param(
        [string]$Command
    )

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    & ssh -i $KeyPath -o StrictHostKeyChecking=accept-new "$Username@$ServerIp" "powershell -NoProfile -EncodedCommand $encoded"
    if ($LASTEXITCODE -ne 0) {
        throw "Remote PowerShell failed with exit code $LASTEXITCODE"
    }
}

function New-AsciiFile {
    param(
        [string]$Path,
        [string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, [Text.Encoding]::ASCII)
}

$relayScript = Join-Path $repoRoot "scripts\rabilink-relay-server.mjs"
$webguiDist = Join-Path $repoRoot "ribiwebgui\dist"
$webguiAssets = Join-Path $repoRoot "assets"
$openApiFile = Join-Path $repoRoot "data\rabilink-relay\rokid-rabilink-plugin.CURRENT.openapi.json"
$manualAuthOpenApiFile = Join-Path $repoRoot "data\rabilink-relay\rokid-rabilink-plugin.MANUAL_AUTH.openapi.json"
$agentTokenOpenApiFile = Join-Path $repoRoot "data\rabilink-relay\rokid-rabilink-plugin.AGENT_TOKEN.openapi.json"
if (-not (Test-Path -LiteralPath $relayScript)) {
    throw "Relay server script was not found: $relayScript"
}
if (-not (Test-Path -LiteralPath (Join-Path $webguiDist "index.html"))) {
    throw "RabiRoute WebGUI build was not found: $webguiDist. Run the WebGUI build before deploying."
}
if (-not (Test-Path -LiteralPath $webguiAssets)) {
    throw "RabiRoute WebGUI asset directory was not found: $webguiAssets"
}
if (-not (Test-Path -LiteralPath $openApiFile)) {
    throw "RabiLink OpenAPI document was not found: $openApiFile"
}
if (-not (Test-Path -LiteralPath $manualAuthOpenApiFile)) {
    throw "RabiLink manual auth OpenAPI document was not found: $manualAuthOpenApiFile"
}
if (-not (Test-Path -LiteralPath $agentTokenOpenApiFile)) {
    throw "RabiLink agent token OpenAPI document was not found: $agentTokenOpenApiFile"
}
if (-not (Test-Path -LiteralPath $KeyPath)) {
    throw "SSH key was not found: $KeyPath"
}

$bundleRoot = Join-Path $env:TEMP ("rabilink-relay-deploy-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss"))
$bundleZip = "$bundleRoot.zip"
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "logs") -Force | Out-Null
$bundleDataRoot = Join-Path $bundleRoot "data"
New-Item -ItemType Directory -Path $bundleDataRoot -Force | Out-Null
Copy-Item -LiteralPath $relayScript -Destination (Join-Path $bundleRoot "rabilink-relay-server.mjs") -Force
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "ribiwebgui") -Force | Out-Null
Copy-Item -LiteralPath $webguiDist -Destination (Join-Path $bundleRoot "ribiwebgui\dist") -Recurse -Force
Copy-Item -LiteralPath $webguiAssets -Destination (Join-Path $bundleRoot "assets") -Recurse -Force
Copy-Item -LiteralPath $openApiFile -Destination (Join-Path $bundleDataRoot "rokid-rabilink-plugin.CURRENT.openapi.json") -Force
Copy-Item -LiteralPath $manualAuthOpenApiFile -Destination (Join-Path $bundleDataRoot "rokid-rabilink-plugin.MANUAL_AUTH.openapi.json") -Force
Copy-Item -LiteralPath $agentTokenOpenApiFile -Destination (Join-Path $bundleDataRoot "rokid-rabilink-plugin.AGENT_TOKEN.openapi.json") -Force

New-AsciiFile -Path (Join-Path $bundleRoot "package.json") -Content @"
{
  "name": "rabilink-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node rabilink-relay-server.mjs"
  }
}
"@

New-AsciiFile -Path (Join-Path $bundleRoot "start-rabilink-relay.ps1") -Content @"
`$ErrorActionPreference = "Continue"
Remove-Item Env:RABILINK_RELAY_TOKEN -ErrorAction SilentlyContinue
`$env:RABILINK_RELAY_PORT = "8788"
`$env:RABILINK_RELAY_HOST = "127.0.0.1"
`$env:RABILINK_RELAY_DATA_DIR = "$RemoteRoot\data"
Set-Location "$RemoteRoot"
New-Item -ItemType Directory -Force -Path "$RemoteRoot\logs" | Out-Null
while (`$true) {
    "`$(Get-Date -Format o) starting RabiLink relay" | Add-Content "$RemoteRoot\logs\rabilink-relay-supervisor.log"
    node "$RemoteRoot\rabilink-relay-server.mjs" *> "$RemoteRoot\logs\rabilink-relay.log"
    "`$(Get-Date -Format o) relay exited; restarting in 3 seconds" | Add-Content "$RemoteRoot\logs\rabilink-relay-supervisor.log"
    Start-Sleep -Seconds 3
}
"@

$publicHttpCaddyBlock = ""
if ($PublicHttpPort -gt 0) {
    $publicHttpCaddyBlock = @"

http://:$PublicHttpPort {
    encode gzip

    handle /health {
        reverse_proxy 127.0.0.1:8788
    }

    handle /rokid/rabilink* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /api/rabilink/mobile* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /openapi* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/messages {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/tasks* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/webgui-requests* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /manage* {
        reverse_proxy 127.0.0.1:8788
    }


    handle {
        respond 404
    }
}
"@
}

New-AsciiFile -Path (Join-Path $bundleRoot "Caddyfile") -Content @"
{
    auto_https disable_redirects
}

http://$Domain {
    encode gzip

    handle /health {
        reverse_proxy 127.0.0.1:8788
    }

    handle /rokid/rabilink* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /api/rabilink/mobile* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /openapi* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/messages {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/tasks* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/webgui-requests* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /manage* {
        reverse_proxy 127.0.0.1:8788
    }


    handle {
        respond 404
    }
}

http://:80 {
    encode gzip

    handle /health {
        reverse_proxy 127.0.0.1:8788
    }

    handle /rokid/rabilink* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /api/rabilink/mobile* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /openapi* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/messages {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/tasks* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/webgui-requests* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /manage* {
        reverse_proxy 127.0.0.1:8788
    }


    handle {
        respond 404
    }
}

https://$Domain {
    encode gzip

    handle /health {
        reverse_proxy 127.0.0.1:8788
    }

    handle /rokid/rabilink* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /api/rabilink/mobile* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /openapi* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/messages {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/tasks* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /worker/webgui-requests* {
        reverse_proxy 127.0.0.1:8788
    }

    handle /manage* {
        reverse_proxy 127.0.0.1:8788
    }


    handle {
        respond 404
    }
}
$publicHttpCaddyBlock
"@

New-AsciiFile -Path (Join-Path $bundleRoot "start-caddy.ps1") -Content @"
`$ErrorActionPreference = "Continue"
Set-Location "$RemoteRoot"
New-Item -ItemType Directory -Force -Path "$RemoteRoot\logs" | Out-Null
while (`$true) {
    "`$(Get-Date -Format o) starting Caddy" | Add-Content "$RemoteRoot\logs\caddy-supervisor.log"
    `$process = Start-Process -FilePath "C:\caddy\caddy.exe" -ArgumentList @("run","--config","$RemoteRoot\Caddyfile") -WorkingDirectory "$RemoteRoot" -RedirectStandardOutput "$RemoteRoot\logs\caddy.stdout.log" -RedirectStandardError "$RemoteRoot\logs\caddy.stderr.log" -WindowStyle Hidden -PassThru
    Wait-Process -Id `$process.Id
    "`$(Get-Date -Format o) Caddy exited with code `$(`$process.ExitCode); restarting in 3 seconds" | Add-Content "$RemoteRoot\logs\caddy-supervisor.log"
    Start-Sleep -Seconds 3
}
"@

New-AsciiFile -Path (Join-Path $bundleRoot "health-check.ps1") -Content @"
`$ErrorActionPreference = "Stop"
`$localHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8788/health" -TimeoutSec 5
if (`$localHealth.ok -ne `$true) { throw "local health did not return ok=true" }
`$domainHealth = Invoke-RestMethod -Uri "http://$Domain/health" -TimeoutSec 15
if (`$domainHealth.ok -ne `$true) { throw "domain health did not return ok=true" }
"@

if (Test-Path -LiteralPath $bundleZip) {
    Remove-Item -LiteralPath $bundleZip -Force
}
Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $bundleZip -Force

$remotePublicHttpFirewall = ""
$remotePublicHttpNetstat = ""
if ($PublicHttpPort -gt 0) {
    $remotePublicHttpFirewall = "netsh advfirewall firewall add rule name=`"RabiLink Relay $PublicHttpPort`" dir=in action=allow protocol=TCP localport=$PublicHttpPort | Out-Null"
    $remotePublicHttpNetstat = "netstat -ano | findstr `":$PublicHttpPort `"`""
}

Write-Host "[deploy] Uploading bundle to $ServerIp" -ForegroundColor Cyan
$sftpBatchPath = Join-Path $env:TEMP ("rabilink-relay-sftp-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".txt")
try {
    Set-Content -LiteralPath $sftpBatchPath -Encoding ASCII -Value @(
        "put `"$bundleZip`" /C:/Windows/Temp/rabilink-relay.zip"
    )
    & sftp -b $sftpBatchPath -i $KeyPath -o StrictHostKeyChecking=accept-new "$Username@$ServerIp"
    if ($LASTEXITCODE -ne 0) {
        throw "sftp failed with exit code $LASTEXITCODE"
    }
} finally {
    if (Test-Path -LiteralPath $sftpBatchPath) {
        Remove-Item -LiteralPath $sftpBatchPath -Force
    }
}

$remoteSetup = @"
`$ErrorActionPreference = "Stop"
`$remoteRoot = "$RemoteRoot"
`$zipPath = "C:\Windows\Temp\rabilink-relay.zip"
New-Item -ItemType Directory -Force -Path `$remoteRoot | Out-Null
Expand-Archive -Path `$zipPath -DestinationPath `$remoteRoot -Force
New-Item -ItemType Directory -Force -Path "`$remoteRoot\logs" | Out-Null

if (Get-Service W3SVC -ErrorAction SilentlyContinue) {
    Stop-Service W3SVC -Force -ErrorAction SilentlyContinue
    Set-Service W3SVC -StartupType Disabled
}

Stop-ScheduledTask -TaskName "RabiLinkCaddy" -ErrorAction SilentlyContinue
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

`$caddyDir = "C:\caddy"
`$caddyExe = Join-Path `$caddyDir "caddy.exe"
New-Item -ItemType Directory -Force -Path `$caddyDir | Out-Null
$remotePublicHttpFirewall
if (-not (Test-Path -LiteralPath `$caddyExe)) {
    `$caddyZip = "C:\Windows\Temp\caddy.zip"
    Invoke-WebRequest -Uri "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" -OutFile `$caddyZip
    Expand-Archive -Path `$caddyZip -DestinationPath `$caddyDir -Force
}

`$taskName = "RabiLinkRelay"
Stop-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { `$_.CommandLine -like "*rabilink-relay-server.mjs*" } |
    ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName `$taskName -Confirm:`$false -ErrorAction SilentlyContinue
`$relayStartScript = Join-Path `$remoteRoot "start-rabilink-relay.ps1"
`$relayTaskArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f `$relayStartScript
`$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument `$relayTaskArguments
`$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName `$taskName -Action `$action -Trigger `$trigger -User "SYSTEM" -RunLevel Highest -Description "RabiLink relay Node.js service" -Force | Out-Null
Start-ScheduledTask -TaskName `$taskName

`$localHealth = `$null
for (`$i = 0; `$i -lt 20; `$i += 1) {
    try {
        `$localHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8788/health" -TimeoutSec 5
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not `$localHealth) {
    throw "RabiLink relay did not pass local health check."
}

& `$caddyExe validate --config "`$remoteRoot\Caddyfile"
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
`$caddyTaskName = "RabiLinkCaddy"
Stop-ScheduledTask -TaskName `$caddyTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName `$caddyTaskName -Confirm:`$false -ErrorAction SilentlyContinue
`$caddyStartScript = Join-Path `$remoteRoot "start-caddy.ps1"
`$caddyTaskArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f `$caddyStartScript
`$caddyAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument `$caddyTaskArguments
`$caddyTrigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName `$caddyTaskName -Action `$caddyAction -Trigger `$caddyTrigger -User "SYSTEM" -RunLevel Highest -Description "RabiLink Caddy reverse proxy" -Force | Out-Null
Start-ScheduledTask -TaskName `$caddyTaskName
Start-Sleep -Seconds 5

Write-Host "localHealth=`$(`$localHealth.status)"
schtasks /Query /TN `$taskName
schtasks /Query /TN "RabiLinkCaddy"
netstat -ano | findstr ":80 "
netstat -ano | findstr ":443 "
$remotePublicHttpNetstat
"@

Write-Host "[deploy] Configuring remote server" -ForegroundColor Cyan
$remoteSetupPath = Join-Path $env:TEMP ("rabilink-relay-remote-setup-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".ps1")
$remoteSetupTarget = "C:\Windows\Temp\rabilink-relay-setup.ps1"
try {
    Set-Content -LiteralPath $remoteSetupPath -Encoding ASCII -Value $remoteSetup
    $setupSftpBatchPath = Join-Path $env:TEMP ("rabilink-relay-setup-sftp-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".txt")
    try {
        Set-Content -LiteralPath $setupSftpBatchPath -Encoding ASCII -Value @(
            "put `"$remoteSetupPath`" /C:/Windows/Temp/rabilink-relay-setup.ps1"
        )
        & sftp -b $setupSftpBatchPath -i $KeyPath -o StrictHostKeyChecking=accept-new "$Username@$ServerIp"
        if ($LASTEXITCODE -ne 0) {
            throw "setup sftp failed with exit code $LASTEXITCODE"
        }
    } finally {
        if (Test-Path -LiteralPath $setupSftpBatchPath) {
            Remove-Item -LiteralPath $setupSftpBatchPath -Force
        }
    }

    & ssh -i $KeyPath -o StrictHostKeyChecking=accept-new "$Username@$ServerIp" "powershell -NoProfile -ExecutionPolicy Bypass -File `"$remoteSetupTarget`""
    if ($LASTEXITCODE -ne 0) {
        throw "Remote setup script failed with exit code $LASTEXITCODE"
    }
} finally {
    if (Test-Path -LiteralPath $remoteSetupPath) {
        Remove-Item -LiteralPath $remoteSetupPath -Force
    }
}

Write-Host "[deploy] Public health check" -ForegroundColor Cyan
$publicHealthUrl = "http://$Domain/health"
try {
    $domainHealth = Invoke-RestMethod -Uri "http://$Domain/health" -TimeoutSec 20
    if ($domainHealth.ok -ne $true) {
        throw "domain health did not return ok=true"
    }
    $domainHealth | ConvertTo-Json -Depth 4
} catch {
    Write-Host "[deploy] domain HTTP health check failed or returned non-Relay content; trying IP fallback" -ForegroundColor Yellow
    $ipHealth = Invoke-RestMethod -Uri "http://$ServerIp/health" -TimeoutSec 10
    if ($ipHealth.ok -ne $true) {
        throw "IP health did not return ok=true"
    }
    $ipHealth | ConvertTo-Json -Depth 4
    $publicHealthUrl = "http://$ServerIp/health"
}

Write-Host "[deploy] Done: $publicHealthUrl" -ForegroundColor Green

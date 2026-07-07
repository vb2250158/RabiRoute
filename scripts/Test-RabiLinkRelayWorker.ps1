param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerBaseUrl,
    [string]$Token = $env:RABILINK_RELAY_TOKEN,
    [switch]$SkipQueueSmoke
)

$ErrorActionPreference = "Stop"

function Join-Url {
    param(
        [string]$Base,
        [string]$Path
    )

    return $Base.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-Step {
    param(
        [string]$Name,
        [string]$Detail = ""
    )

    if ($Detail) {
        Write-Host "[ok] $Name - $Detail" -ForegroundColor Green
    } else {
        Write-Host "[ok] $Name" -ForegroundColor Green
    }
}

if (-not $WorkerBaseUrl.Trim()) {
    throw "WorkerBaseUrl is required."
}

$base = $WorkerBaseUrl.TrimEnd("/")
$health = Invoke-RestMethod -Method Get -Uri (Join-Url $base "/health") -TimeoutSec 20
Assert-True ($health.ok -eq $true) "Worker /health did not return ok=true."
Write-Step "worker health" $base

$openApiUrl = Join-Url $base "/rokid/rabilink/openapi.json"
$openApi = Invoke-RestMethod -Method Get -Uri $openApiUrl -TimeoutSec 20
Assert-True ($openApi.info.title -eq "RabiLinkMessage") "Worker OpenAPI title was not RabiLinkMessage."
Assert-True ($openApi.servers[0].url -eq $base) "Worker OpenAPI server URL was not rewritten to WorkerBaseUrl."
Assert-True ([bool]$openApi.paths."/rokid/rabilink/messages".get) "Worker OpenAPI should expose global /rokid/rabilink/messages."
Assert-True (-not $openApi.paths."/rokid/rabilink/messages".get.requestBody) "Worker GET /rokid/rabilink/messages should not define requestBody."
Assert-True ([bool]$openApi.paths."/rokid/rabilink/tasks/{taskId}/messages".get) "Worker OpenAPI should expose taskId message list."
Assert-True (-not $openApi.paths."/rokid/rabilink/tasks/{taskId}/messages".get.requestBody) "GET /rokid/rabilink/tasks/{taskId}/messages should not define requestBody."
Write-Step "worker openapi" $openApiUrl

$manualAuthOpenApiUrl = Join-Url $base "/rokid/rabilink/openapi.manual-auth.json"
$manualAuthOpenApi = Invoke-RestMethod -Method Get -Uri $manualAuthOpenApiUrl -TimeoutSec 20
Assert-True ($manualAuthOpenApi.info.title -eq "RabiLinkMessage") "Worker manual-auth OpenAPI title was not RabiLinkMessage."
Assert-True ($manualAuthOpenApi.servers[0].url -eq $base) "Worker manual-auth OpenAPI server URL was not rewritten to WorkerBaseUrl."
Assert-True (-not [bool]$manualAuthOpenApi.components.securitySchemes.RabiLinkToken) "Worker manual-auth OpenAPI should not define RabiLinkToken security scheme."
Assert-True ([bool]$manualAuthOpenApi.paths."/rokid/rabilink/messages".get) "Worker manual-auth OpenAPI should expose global /rokid/rabilink/messages."
Assert-True (-not $manualAuthOpenApi.paths."/rokid/rabilink/messages".get.requestBody) "Worker manual-auth GET /rokid/rabilink/messages should not define requestBody."
Assert-True ([bool]$manualAuthOpenApi.paths."/rokid/rabilink/tasks/{taskId}/messages".get) "Worker manual-auth OpenAPI should expose taskId message list."
Assert-True (-not $manualAuthOpenApi.paths."/rokid/rabilink/tasks/{taskId}/messages".get.requestBody) "Manual-auth GET /rokid/rabilink/tasks/{taskId}/messages should not define requestBody."
Write-Step "worker manual-auth openapi" $manualAuthOpenApiUrl

try {
    Invoke-RestMethod -Method Get -Uri (Join-Url $base "/rokid/rabilink/tasks/auth-check/messages?after=0&waitMs=0") -TimeoutSec 20 | Out-Null
    throw "Unauthenticated Worker task messages request unexpectedly succeeded."
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Assert-True ($statusCode -eq 401) "Unauthenticated Worker task messages request should return 401, got $statusCode."
}
Write-Step "worker auth gate" "unauthenticated task messages request returns 401"

if ($SkipQueueSmoke) {
    Write-Host "[skip] worker queue smoke" -ForegroundColor Yellow
    exit 0
}

if (-not $Token.Trim()) {
    throw "Token is required for worker queue smoke. Pass -Token or set RABILINK_RELAY_TOKEN. Use -SkipQueueSmoke to skip authenticated checks."
}

$authHeaders = @{
    "X-RabiLink-Token" = $Token
}
$jsonHeaders = @{
    "X-RabiLink-Token" = $Token
    "Content-Type" = "application/json"
}

$submitBody = @{
    text = "rabilink worker smoke"
    sender = "rabilink-worker-smoke"
    context = "worker relay self test"
} | ConvertTo-Json -Compress
$submit = Invoke-RestMethod -Method Post -Uri (Join-Url $base "/rokid/rabilink/tasks") -Headers $jsonHeaders -Body $submitBody -TimeoutSec 20
Assert-True ($submit.ok -eq $true) "Worker task submit did not return ok=true."
$taskId = [string]$submit.taskId
Assert-True ([bool]$taskId) "Worker task submit did not return taskId."
$globalAfter = [string]$submit.nextCursor

$finishBody = @{
    text = "rabilink worker smoke ok"
    ok = $true
} | ConvertTo-Json -Compress
$finish = Invoke-RestMethod -Method Post -Uri (Join-Url $base "/worker/tasks/$taskId/finish") -Headers $jsonHeaders -Body $finishBody -TimeoutSec 20
Assert-True ($finish.ok -eq $true) "Worker task finish did not return ok=true."

$messagesUrl = Join-Url $base ("/rokid/rabilink/messages?after={0}&waitMs=0" -f [uri]::EscapeDataString($globalAfter))
$outbox = Invoke-RestMethod -Method Get -Uri $messagesUrl -Headers $authHeaders -TimeoutSec 20
Assert-True ($outbox.ok -eq $true) "Worker global messages did not return ok=true."
Assert-True (@($outbox.messages).Count -ge 1) "Worker global messages did not return smoke message."
Assert-True (($outbox.messages | ConvertTo-Json -Depth 5) -like "*$taskId*") "Worker global messages did not include the smoke taskId."
Assert-True (($outbox.text -like "*rabilink worker smoke ok*") -or (($outbox.messages | ConvertTo-Json -Depth 5) -like "*rabilink worker smoke ok*")) "Worker global messages did not contain smoke reply."
Write-Step "worker queue smoke" ("taskId present, global messages={0}, nextCursor={1}" -f @($outbox.messages).Count, $outbox.nextCursor)

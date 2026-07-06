param(
    [string]$BaseUrl = "https://rabi.example.com",
    [string]$DomainBaseUrl = "",
    [string]$ExpectedOpenApiServerUrl = "",
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

function Write-Info {
    param(
        [string]$Message
    )

    Write-Host "[info] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param(
        [string]$Message
    )

    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Test-OptionalOpenApiUrl {
    param(
        [string]$CandidateBaseUrl
    )

    if (-not $CandidateBaseUrl.Trim()) {
        return
    }

    $candidate = Join-Url $CandidateBaseUrl "/rokid/rabilink/openapi.json"
    try {
        $response = Invoke-WebRequest -Method Get -Uri $candidate -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0
        if ($response.StatusCode -eq 200 -and (($response.Headers["Content-Type"] -join ",") -like "*application/json*")) {
            $doc = $response.Content | ConvertFrom-Json
            if ($doc.info.title -eq "RabiLinkMessage") {
                Write-Step "domain openapi" $candidate
                return
            }
        }
        Write-Warn "domain OpenAPI returned unexpected content: $candidate"
    } catch {
        $response = $_.Exception.Response
        $location = ""
        if ($response) {
            $location = [string]$response.Headers["Location"]
        }

        Write-Warn "domain OpenAPI is not usable now: $candidate"
        if ($location -like "*dnspod.qcloud.com/static/webblock.html*") {
            Write-Warn "DNSPod/Tencent Cloud webblock detected: $location"
            Write-Warn "this is a domain/ICP/host policy issue before the request reaches Caddy."
        }
        Write-Warn "use the IP import URL when the platform accepts it; otherwise deploy the Cloudflare Worker proxy or use a registered domain."
    }
}

if (-not $BaseUrl.Trim()) {
    throw "BaseUrl is required."
}

$expectedServerUrl = if ($ExpectedOpenApiServerUrl.Trim()) {
    $ExpectedOpenApiServerUrl.TrimEnd("/")
} else {
    $BaseUrl.TrimEnd("/")
}

$health = Invoke-RestMethod -Method Get -Uri (Join-Url $BaseUrl "/health") -TimeoutSec 10
Assert-True ($health.ok -eq $true) "Health check did not return ok=true."
Write-Step "health" ("queue total={0}, queued={1}" -f $health.queue.total, $health.queue.queued)

$openApiUrl = Join-Url $BaseUrl "/rokid/rabilink/openapi.json"
$openApiResponse = Invoke-WebRequest -Method Get -Uri $openApiUrl -UseBasicParsing -TimeoutSec 10
Assert-True ($openApiResponse.StatusCode -eq 200) "OpenAPI HTTP status was not 200."
Assert-True (($openApiResponse.Headers["Content-Type"] -join ",") -like "*application/json*") "OpenAPI response was not application/json."
$openApi = $openApiResponse.Content | ConvertFrom-Json
Assert-True ($openApi.info.title -eq "RabiLinkMessage") "OpenAPI title was not RabiLinkMessage."
Assert-True ($openApi.servers[0].url -eq $expectedServerUrl) "OpenAPI server URL does not match expected server URL."
Assert-True ([bool]$openApi.components.securitySchemes.RabiLinkToken) "OpenAPI is missing RabiLinkToken security scheme."
Assert-True (-not $openApi.paths."/rokid/rabilink/messages".get.requestBody) "GET /rokid/rabilink/messages should not define requestBody."
Write-Step "openapi" $openApiUrl
Write-Info "Rizon URL import: $openApiUrl"
Write-Info "Rizon URL import should prefer the verified HTTPS domain."

$manualAuthOpenApiUrl = Join-Url $BaseUrl "/rokid/rabilink/openapi.manual-auth.json"
$manualAuthOpenApiResponse = Invoke-WebRequest -Method Get -Uri $manualAuthOpenApiUrl -UseBasicParsing -TimeoutSec 10
Assert-True ($manualAuthOpenApiResponse.StatusCode -eq 200) "Manual-auth OpenAPI HTTP status was not 200."
Assert-True (($manualAuthOpenApiResponse.Headers["Content-Type"] -join ",") -like "*application/json*") "Manual-auth OpenAPI response was not application/json."
$manualAuthOpenApi = $manualAuthOpenApiResponse.Content | ConvertFrom-Json
Assert-True ($manualAuthOpenApi.info.title -eq "RabiLinkMessage") "Manual-auth OpenAPI title was not RabiLinkMessage."
Assert-True ($manualAuthOpenApi.servers[0].url -eq $expectedServerUrl) "Manual-auth OpenAPI server URL does not match expected server URL."
Assert-True (-not [bool]$manualAuthOpenApi.components.securitySchemes.RabiLinkToken) "Manual-auth OpenAPI should not define RabiLinkToken security scheme."
Assert-True (-not $manualAuthOpenApi.paths."/rokid/rabilink/messages".get.requestBody) "Manual-auth GET /rokid/rabilink/messages should not define requestBody."
Write-Step "manual-auth openapi" $manualAuthOpenApiUrl
Write-Info "Rizon fallback import: $manualAuthOpenApiUrl"
Test-OptionalOpenApiUrl -CandidateBaseUrl $DomainBaseUrl

try {
    Invoke-RestMethod -Method Get -Uri (Join-Url $BaseUrl "/rokid/rabilink/messages?after=0&waitMs=0") -TimeoutSec 10 | Out-Null
    throw "Unauthenticated messages request unexpectedly succeeded."
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Assert-True ($statusCode -eq 401) "Unauthenticated messages request should return 401, got $statusCode."
}
Write-Step "auth gate" "unauthenticated messages request returns 401"

if ($SkipQueueSmoke) {
    Write-Host "[skip] queue smoke" -ForegroundColor Yellow
    exit 0
}

if (-not $Token.Trim()) {
    throw "Token is required for queue smoke. Pass -Token or set RABILINK_RELAY_TOKEN. Use -SkipQueueSmoke to skip authenticated checks."
}

$authHeaders = @{
    "X-RabiLink-Token" = $Token
}
$jsonHeaders = @{
    "X-RabiLink-Token" = $Token
    "Content-Type" = "application/json"
}

$before = Invoke-RestMethod -Method Get -Uri (Join-Url $BaseUrl "/rokid/rabilink/messages?waitMs=0") -Headers $authHeaders -TimeoutSec 10
$after = [string]$before.nextCursor

$submitBody = @{
    text = "rabilink public smoke"
    sender = "rabilink-relay-smoke"
    context = "public relay self test"
} | ConvertTo-Json -Compress
$submit = Invoke-RestMethod -Method Post -Uri (Join-Url $BaseUrl "/rokid/rabilink/tasks") -Headers $jsonHeaders -Body $submitBody -TimeoutSec 10
Assert-True ($submit.ok -eq $true) "Task submit did not return ok=true."
$taskId = [string]$submit.taskId
Assert-True ([bool]$taskId) "Task submit did not return taskId."

$finishBody = @{
    text = "rabilink public smoke ok"
    ok = $true
} | ConvertTo-Json -Compress
$finish = Invoke-RestMethod -Method Post -Uri (Join-Url $BaseUrl "/phone/tasks/$taskId/finish") -Headers $jsonHeaders -Body $finishBody -TimeoutSec 10
Assert-True ($finish.ok -eq $true) "Task finish did not return ok=true."

$messagesUrl = Join-Url $BaseUrl ("/rokid/rabilink/messages?after={0}&waitMs=0" -f [uri]::EscapeDataString($after))
$outbox = Invoke-RestMethod -Method Get -Uri $messagesUrl -Headers $authHeaders -TimeoutSec 10
Assert-True ($outbox.ok -eq $true) "Outbox messages did not return ok=true."
Assert-True (@($outbox.messages).Count -ge 1) "Outbox did not return smoke message."
Assert-True (($outbox.text -like "*rabilink public smoke ok*") -or (($outbox.messages | ConvertTo-Json -Depth 5) -like "*rabilink public smoke ok*")) "Outbox did not contain smoke reply."
Write-Step "queue smoke" ("taskId present, messages={0}, nextCursor={1}" -f @($outbox.messages).Count, $outbox.nextCursor)

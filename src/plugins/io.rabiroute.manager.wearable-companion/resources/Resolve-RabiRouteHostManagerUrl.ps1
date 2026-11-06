function Resolve-RabiRouteHostManagerIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ManagerUrl,
        [Parameter(Mandatory)][string]$ApplicationGenerationId,
        [Parameter(Mandatory)][string]$ManagerInstanceId
    )

    $candidate = $ManagerUrl.Trim()
    $generation = $ApplicationGenerationId.Trim()
    $manager = $ManagerInstanceId.Trim()
    if (-not $candidate -or -not $generation -or -not $manager) {
        throw "Manager URL and both lifecycle identity fields are required."
    }
    try { $uri = [Uri]$candidate } catch { throw "Manager URL is invalid." }
    if ($uri.Scheme -ne "http" -or $uri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]") -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or $uri.AbsolutePath -ne "/") {
        throw "Manager URL must be an HTTP loopback authority without credentials or a path."
    }
    $baseUrl = $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
    $headers = @{
        "x-rabiroute-expected-application-generation-id" = $generation
        "x-rabiroute-expected-manager-instance-id" = $manager
    }
    try {
        $meta = Invoke-RestMethod -Uri "$baseUrl/meta" -Method Get -Headers $headers -TimeoutSec 5
    } catch {
        throw "RabiRoute Manager did not return a fenced identity document."
    }
    if ([string]$meta.managerBaseUrl -ne $baseUrl -or
        [string]$meta.applicationGenerationId -ne $generation -or
        [string]$meta.managerInstanceId -ne $manager) {
        throw "RabiRoute Manager identity does not match the Host-owned application generation."
    }
    return [pscustomobject]@{
        ManagerBaseUrl = $baseUrl
        ApplicationGenerationId = $generation
        ManagerInstanceId = $manager
        Headers = $headers
    }
}

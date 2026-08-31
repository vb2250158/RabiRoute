import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkPath = path.join(
  repoRoot,
  "packages",
  "android-sdk",
  "rabiroute-sdk",
  "src",
  "main",
  "java",
  "com",
  "rabiroute",
  "sdk",
  "RabiRouteSdk.kt"
);
const discoveryContractPath = path.join(
  repoRoot,
  "packages",
  "android-sdk",
  "rabiroute-sdk",
  "src",
  "main",
  "java",
  "com",
  "rabiroute",
  "sdk",
  "RabiRouteDiscoveryContract.kt"
);
const nsdDiscoveryPath = path.join(
  repoRoot,
  "packages",
  "android-sdk",
  "rabiroute-sdk",
  "src",
  "main",
  "java",
  "com",
  "rabiroute",
  "sdk",
  "RabiRouteNsdDiscovery.kt"
);
const jvmTestPath = path.join(
  repoRoot,
  "packages",
  "android-sdk",
  "rabiroute-sdk",
  "src",
  "test",
  "java",
  "com",
  "rabiroute",
  "sdk",
  "RabiRouteDiscoveryContractJvmTest.kt"
);

test("Android SDK discovers only explicit full Manager URLs", () => {
  const source = fs.readFileSync(sdkPath, "utf8");
  assert.match(source, /private val managerBaseUrls: List<String> = emptyList\(\)/);
  assert.match(source, /RabiRouteNsdDiscovery\(context, timeoutMs\)\.discoverManagerEndpoints\(\)/);
  assert.match(source, /val configuredBaseUrls = managerBaseUrls\s+\.map\(::normalizeManagerBaseUrl\)/);
  assert.match(source, /fun scanManagerBaseUrls\(baseUrls: List<String>\)/);
  assert.match(source, /baseUrls\.map\(::normalizeManagerBaseUrl\)\.distinct\(\)/);
  assert.doesNotMatch(source, /8790\.\.8799|\?:\s*8790|\bports: List<Int>\b/);
});

test("Android SDK uses bounded DNS-SD discovery and serial resolution", () => {
  const contract = fs.readFileSync(discoveryContractPath, "utf8");
  const discovery = fs.readFileSync(nsdDiscoveryPath, "utf8");
  assert.match(contract, /const val SERVICE_TYPE = "_rabiroute\._tcp\."/);
  assert.match(contract, /const val WELL_KNOWN_PATH = "\/\.well-known\/rabiroute-manager"/);
  assert.match(contract, /const val PROTOCOL_VERSION = 1/);
  assert.match(contract, /const val MIN_DISCOVERY_WINDOW_MS = 1_500L/);
  assert.match(contract, /coerceAtLeast\(MIN_DISCOVERY_WINDOW_MS\)/);
  assert.match(contract, /const val MAX_RESOLVED_SERVICES = 16/);
  assert.match(contract, /const val MAX_TOTAL_RESOLUTION_MS = 6_000L/);
  assert.match(contract, /addresses\.firstOrNull \{ it is Inet4Address \} \?: addresses\.firstOrNull\(\)/);
  assert.match(discovery, /discoverServices\(\s*RabiRouteDiscoveryContract\.SERVICE_TYPE,/);
  assert.match(discovery, /for \(serviceInfo in services\.take\(RabiRouteDiscoveryContract\.MAX_RESOLVED_SERVICES\)\)/);
  assert.match(discovery, /nsdManager\.resolveService\(serviceInfo, listener\)/);
  assert.match(discovery, /resolution exceeded its total time budget/);
  assert.match(discovery, /is ResolveResult\.Timeout -> throw IllegalStateException\(result\.message\)/);
  assert.match(discovery, /no overlapping resolve was started/);
  assert.match(discovery, /lifecycleIdentityFromTxt\(serviceInfo\)/);
  assert.match(discovery, /txtValue\(serviceInfo, "applicationGenerationId"\)/);
  assert.match(discovery, /txtValue\(serviceInfo, "managerInstanceId"\)/);
  assert.doesNotMatch(discovery, /8790\.\.8799|\?:\s*8790|candidateHosts|for \(port in/);
});

test("Android SDK discovery failures remain explicit", () => {
  const source = fs.readFileSync(sdkPath, "utf8");
  const discovery = fs.readFileSync(nsdDiscoveryPath, "utf8");
  assert.match(discovery, /Android DNS-SD discovery failed to start/);
  assert.match(discovery, /found \$\{services\.size\} RabiRoute service\(s\), but none could be resolved/);
  assert.match(source, /val verified = readIdentityDocument\(endpoint\.baseUrl\)/);
  assert.match(discovery, /if \(services\.isEmpty\(\)\) return emptyList\(\)/);
});

test("Android SDK fences DNS-SD records to the exact Manager generation", () => {
  const source = fs.readFileSync(sdkPath, "utf8");
  const contract = fs.readFileSync(discoveryContractPath, "utf8");
  const discovery = fs.readFileSync(nsdDiscoveryPath, "utf8");
  assert.match(discovery, /RabiRouteDiscoveredManagerEndpoint\(/);
  assert.match(discovery, /lifecycleIdentity = lifecycleIdentity/);
  assert.match(source, /RabiRouteDiscoveryContract\.requireMatchingIdentity\(/);
  assert.match(source, /advertised = endpoint\.lifecycleIdentity/);
  assert.match(source, /observed = verified\.lifecycleIdentity/);
  assert.match(contract, /advertised\.applicationGenerationId == observed\.applicationGenerationId/);
  assert.match(contract, /advertised\.managerInstanceId == observed\.managerInstanceId/);
  assert.match(contract, /DNS-SD applicationGenerationId does not match/);
  assert.match(contract, /DNS-SD managerInstanceId does not match/);
  assert.match(source, /val applicationGenerationId: String/);
  assert.match(source, /val managerInstanceId: String/);
  assert.match(source, /managerLifecycleHeaders\(instance: RabiInstance\)/);
  assert.match(source, /x-rabiroute-expected-application-generation-id/);
  assert.match(source, /x-rabiroute-expected-manager-instance-id/);
  assert.match(source, /getManagerJson\(instance, url\)/);
  assert.match(source, /requestManagerJson\(instance, url, "PATCH"/);
  assert.match(source, /requestManagerJson\(instance, "\$\{instance\.baseUrl\}\/api\/agent\/send"/);
});

test("Android SDK keeps executable pure JVM discovery contract tests", () => {
  const source = fs.readFileSync(jvmTestPath, "utf8");
  assert.match(source, /discoveryWindowMs\(160\) == 1_500L/);
  assert.match(source, /preferredAddress\(listOf\(ipv6, ipv4\)\) == ipv4/);
  assert.match(source, /managerBaseUrl\("192\.0\.2\.42", 43127\) == "http:\/\/192\.0\.2\.42:43127"/);
  assert.match(source, /managerBaseUrl\("2001:db8::1", 43127\)/);
  assert.match(source, /copy\(applicationGenerationId = "generation-b"\)/);
  assert.match(source, /copy\(managerInstanceId = "manager-b"\)/);
});

test("Android SDK Manager URL parsing fails closed", () => {
  const source = fs.readFileSync(sdkPath, "utf8");
  assert.match(source, /Manager base URL must be an explicit HTTP address/);
  assert.match(source, /must not contain credentials, a path, query, or fragment/);
  assert.match(source, /Manager base URL must include a valid port/);
  assert.match(source, /val port = if \(parsed\.port == -1\) parsed\.defaultPort else parsed\.port/);
  assert.doesNotMatch(source, /parsed\.port\.takeIf[^\n]+\?:\s*parsed\.defaultPort/);
  assert.match(source, /val normalizedBaseUrl = normalizeManagerBaseUrl\(baseUrl\)/);
  assert.match(source, /"\$normalizedBaseUrl\$\{RabiRouteDiscoveryContract\.WELL_KNOWN_PATH\}"/);
  assert.match(source, /maxResponseBytes = 64 \* 1024/);
  assert.match(source, /instanceFollowRedirects = false/);
  assert.match(source, /readBoundedUtf8\(it, maxResponseBytes\)/);
  assert.match(source, /RabiRouteDiscoveryContract\.requireValidIdentity\(/);
  assert.doesNotMatch(source, /\/api\/rabi\/identity/);
});

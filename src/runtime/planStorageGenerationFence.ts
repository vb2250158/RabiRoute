export type PlanStorageGenerationLease = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
  managerBaseUrl: string;
}>;

export type PlanStorageGenerationFenceOptions = Readonly<{
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

const MAX_HEALTH_BYTES = 128 * 1024;

function requiredIdentity(value: unknown, field: string): string {
  const normalized = String(value || "").trim();
  if (normalized.length < 8
    || normalized.length > 128
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${field} is missing or invalid.`);
  }
  return normalized;
}

function loopbackManagerOrigin(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("GATEWAY_MANAGER_URL must be the active HTTP loopback Manager origin.");
  }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("GATEWAY_MANAGER_URL must be the active HTTP loopback Manager origin.");
  }
  return parsed.origin;
}

/**
 * Reuses the Host READY generation/instance tuple; it does not mint a second
 * storage identity. Manager-owned one-shot and Gateway children must verify
 * this lease before touching role plan storage.
 */
export function planStorageGenerationLeaseFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): PlanStorageGenerationLease {
  return Object.freeze({
    applicationGenerationId: requiredIdentity(
      environment.RABIROUTE_APPLICATION_GENERATION_ID,
      "RABIROUTE_APPLICATION_GENERATION_ID"
    ),
    managerInstanceId: requiredIdentity(
      environment.RABIROUTE_MANAGER_INSTANCE_ID,
      "RABIROUTE_MANAGER_INSTANCE_ID"
    ),
    managerBaseUrl: loopbackManagerOrigin(environment.GATEWAY_MANAGER_URL)
  });
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export async function verifyPlanStorageGenerationLease(
  lease: PlanStorageGenerationLease,
  options: PlanStorageGenerationFenceOptions = {}
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 5_000;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  deadline.unref?.();
  try {
    const response = await fetchImpl(new URL("/health", lease.managerBaseUrl), {
      method: "GET",
      redirect: "error",
      headers: {
        "x-rabiroute-expected-application-generation-id": lease.applicationGenerationId,
        "x-rabiroute-expected-manager-instance-id": lease.managerInstanceId
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Manager generation health returned HTTP ${response.status}.`);
    }
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > MAX_HEALTH_BYTES) {
      throw new Error("Manager generation health response exceeds its size limit.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HEALTH_BYTES) {
      throw new Error("Manager generation health response exceeds its size limit.");
    }
    const payload = objectRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      "Manager generation health response"
    );
    if (payload.applicationGenerationId !== lease.applicationGenerationId
      || payload.managerInstanceId !== lease.managerInstanceId
      || loopbackManagerOrigin(payload.managerBaseUrl) !== lease.managerBaseUrl) {
      throw new Error("Manager generation identity changed before the child acquired plan-storage eligibility.");
    }
    const background = objectRecord(payload.backgroundLifecycle, "Manager background lifecycle");
    const planStorage = objectRecord(background.planStorageStartup, "Manager plan-storage lifecycle");
    if (planStorage.state !== "ready") {
      throw new Error(`Manager plan-storage generation is not ready: ${String(planStorage.state || "unknown")}.`);
    }
  } finally {
    clearTimeout(deadline);
  }
}

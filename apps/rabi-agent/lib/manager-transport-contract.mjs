/** Optional transport facts. These headers select the intended Manager; they never grant API permissions. */
export const MANAGER_TRANSPORT_ABI = 1;
export const MANAGER_CONTEXT_HEADER = "x-rabiroute-manager-context";
export const EXPECTED_MANAGER_GENERATION_HEADER = "x-rabiroute-expected-application-generation-id";
export const EXPECTED_MANAGER_INSTANCE_HEADER = "x-rabiroute-expected-manager-instance-id";
export function managerContextFromHeaders(headers) {
  const value = typeof headers?.get === "function" ? headers.get(MANAGER_CONTEXT_HEADER) : headers?.[MANAGER_CONTEXT_HEADER];
  if (typeof value !== "string") return undefined;
  try {
    const context = JSON.parse(value);
    if (context?.abi !== MANAGER_TRANSPORT_ABI || typeof context.applicationGenerationId !== "string" || !context.applicationGenerationId
      || typeof context.managerInstanceId !== "string" || !context.managerInstanceId || typeof context.metadataRevision !== "string") return undefined;
    return context;
  } catch { return undefined; }
}

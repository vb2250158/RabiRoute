import type { createProtectedResourceObjects } from "@rabiroute/host-api/manager/protectedResourceObjects";
/** The existing host secret-protection owner seals metadata in the same original ResourceCache. */
export type NativeProtectedResourceObjects = ReturnType<typeof createProtectedResourceObjects>;

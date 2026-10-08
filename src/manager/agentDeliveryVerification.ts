import { readNapCatGroupFiles, type GroupFilesPage, type NapCatEndpoint } from "../napcat.js";

/** Immutable evidence from the original delivery; names cannot identify a file. */
export type OriginalQqFileBinding = Readonly<{
  routeId: string;
  instanceId: string;
  groupId: string;
  platformFileId: string;
  folderId?: string;
  selfId: string;
  bindingRevision: string;
}>;

export type CurrentQqFileBinding = Readonly<{
  routeId: string;
  instanceId: string;
  groupId: string;
  selfId: string;
  bindingRevision: string;
  readAllowed: boolean;
  endpoint: Readonly<NapCatEndpoint>;
}>;

/** Trusted read-only callbacks, not a generic action/transport or delivery capability. */
export type QqFileVerificationDependencies = Readonly<{
  readCurrentBinding: (original: OriginalQqFileBinding) => CurrentQqFileBinding | undefined | Promise<CurrentQqFileBinding | undefined>;
  readAccountIdentity: (binding: CurrentQqFileBinding, signal: AbortSignal) => Promise<Readonly<{ selfId: string }> | undefined>;
  readFiles?: (endpoint: NapCatEndpoint, groupId: string, folderId?: string) => Promise<GroupFilesPage>;
}>;

export type QqFileVerificationResult = Readonly<{
  status: "present" | "unknown" | "conflict";
  reason: "exact_file_id" | "invalid_evidence" | "binding_unavailable" | "binding_changed" | "permission_denied" | "account_unavailable" | "account_changed" | "endpoint_unsafe" | "not_observed" | "read_failed";
  deliveredNow: false;
  retryAllowed: false;
  sha256Verified: false;
  captionVerified: false;
}>;

const result = (status: QqFileVerificationResult["status"], reason: QqFileVerificationResult["reason"]): QqFileVerificationResult =>
  ({ status, reason, deliveredNow: false, retryAllowed: false, sha256Verified: false, captionVerified: false });
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

function safeEndpoint(endpoint: NapCatEndpoint): boolean {
  try {
    const url = new URL(endpoint.httpUrl);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      && typeof endpoint.accessToken === "string";
  } catch { return false; }
}

function checkBinding(original: OriginalQqFileBinding, binding: CurrentQqFileBinding | undefined, before?: CurrentQqFileBinding): QqFileVerificationResult | undefined {
  if (!binding) return result("unknown", "binding_unavailable");
  if (![binding.routeId, binding.instanceId, binding.groupId, binding.selfId, binding.bindingRevision].every(validText)) return result("unknown", "invalid_evidence");
  if (binding.routeId !== original.routeId || binding.instanceId !== original.instanceId || binding.groupId !== original.groupId
    || binding.selfId !== original.selfId || binding.bindingRevision !== original.bindingRevision
    || (before && (binding.endpoint.httpUrl !== before.endpoint.httpUrl || binding.endpoint.accessToken !== before.endpoint.accessToken))) {
    return result("conflict", "binding_changed");
  }
  if (binding.readAllowed !== true) return result("unknown", "permission_denied");
  if (!safeEndpoint(binding.endpoint)) return result("unknown", "endpoint_unsafe");
}

/** Single bounded observation. Never proves absence, SHA-256, caption, or a new delivery. */
export async function verifyQqFileCurrentPresence(original: OriginalQqFileBinding, dependencies: QqFileVerificationDependencies): Promise<QqFileVerificationResult> {
  try {
    // Copy primitive evidence before awaiting: mutable caller objects cannot move the fence.
    const expected = Object.freeze({ ...original });
    if (![expected.routeId, expected.instanceId, expected.platformFileId, expected.bindingRevision].every(validText)
      || !/^[1-9][0-9]{0,15}$/.test(expected.groupId) || !/^[1-9][0-9]{0,15}$/.test(expected.selfId)
      || (expected.folderId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(expected.folderId))
      || typeof dependencies.readAccountIdentity !== "function") return result("unknown", "invalid_evidence");

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Verification deadline")); }, 3000);
    });
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, timeout]);
    try {
      const current = await bounded(Promise.resolve(dependencies.readCurrentBinding(expected)));
      const denied = checkBinding(expected, current);
      if (denied) return denied;
      const before: CurrentQqFileBinding = Object.freeze({ ...current!, endpoint: Object.freeze({ ...current!.endpoint }) });
      const account = await bounded(dependencies.readAccountIdentity(before, controller.signal));
      if (!validText(account?.selfId)) return result("unknown", "account_unavailable");
      if (account.selfId !== expected.selfId) return result("conflict", "account_changed");
      const preRead = checkBinding(expected, await bounded(Promise.resolve(dependencies.readCurrentBinding(expected))), before);
      if (preRead) return preRead;
      const page = await bounded((dependencies.readFiles ?? readNapCatGroupFiles)({ ...before.endpoint }, expected.groupId, expected.folderId));
      const afterAccount = await bounded(dependencies.readAccountIdentity(before, controller.signal));
      const postRead = checkBinding(expected, await bounded(Promise.resolve(dependencies.readCurrentBinding(expected))), before);
      if (postRead) return postRead;
      if (!validText(afterAccount?.selfId)) return result("unknown", "account_unavailable");
      if (afterAccount.selfId !== expected.selfId) return result("conflict", "account_changed");
      if (!page || !Array.isArray(page.files) || !Array.isArray(page.folders) || page.files.length > 50
        || page.completenessUnknown !== true || page.potentiallyTruncated !== true || typeof page.projectionTruncated !== "boolean"
        || page.files.length + page.folders.length > 50
        || page.files.some(file => !file || !validText(file.fileId) || !validText(file.fileName))
        || page.folders.some(folder => !folder || !validText(folder.folderId) || !validText(folder.folderName))) return result("unknown", "invalid_evidence");
      return page.files.some(file => file.fileId === expected.platformFileId)
        ? result("present", "exact_file_id") : result("unknown", "not_observed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch {
    // Never expose callback errors, URLs, tokens, names, account data or platform bodies.
    return result("unknown", "read_failed");
  }
}

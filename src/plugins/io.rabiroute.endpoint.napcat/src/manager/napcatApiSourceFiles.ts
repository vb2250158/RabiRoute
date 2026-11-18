import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeReadableGroupFileIds } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { readExactQqMessage } from "./qqMessageRoutes.js";
import { selectNapcatApiInstance, verifyNapcatApiIdentity, NapcatApiError,
  type NapcatApiSelection, type NapcatApiTransportContext } from "./napcatApiTransport.js";
import { qqMessageMedia, resolveQqSourceFile, readResolvedQqMediaBytes, resolvedQqMediaUrl, consumeBoundedQqBytes } from "./qqMessageMedia.js";

const id = { type: "string", pattern: "^[1-9][0-9]{0,15}$" };
const selector = { type: "string", minLength: 1, maxLength: 256 };
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const sourceSchema = (kind: "private" | "group") => objectSchema({ kind: { const: kind }, targetId: id,
  messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }, attachmentIndex: { type: "integer", minimum: 0 } });
const base = { routeId: selector, instanceId: selector };
export const privateFileBodySchema = objectSchema({ ...base, source: sourceSchema("private") });
export const groupFileBodySchema = { oneOf: [objectSchema({ ...base, source: sourceSchema("group") }), objectSchema({ ...base,
  group: objectSchema({ groupId: id, fileId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" } }) })] };

type SourceInput = { routeId: string; instanceId: string; source: { kind: "group" | "private"; targetId: string; messageId: string; attachmentIndex: number } };
type GroupInput = { routeId: string; instanceId: string; group: { groupId: string; fileId: string } };
export type SourceFileInput = SourceInput | GroupInput;
export type SourceFileResult = { bytes: Buffer; name: string; sha256: string; nativeContractEquivalent: false };

export function assertSourceGroupFileAccess(context: NapcatApiTransportContext, selection: NapcatApiSelection, groupId: string) {
  selection.assertCurrent();
  const configured = context.route(selection.routeId)?.messageAdapterPolicies?.napcat?.readableGroupFileIds;
  if (configured !== undefined && !normalizeReadableGroupFileIds(configured).includes(groupId)) throw new NapcatApiError(403, "QQ_GROUP_FILES_GROUP_NOT_ALLOWED");
}

/** The HTTP operation validates its closed source DTO before entering this original-owner flow. */
async function resolveSourceFile(context: NapcatApiTransportContext, request: IncomingMessage, input: SourceFileInput, signal: AbortSignal) {
  const selection = selectNapcatApiInstance(context, request, input.routeId, input.instanceId, signal);
  await verifyNapcatApiIdentity(context, selection, signal);
  let media;
  let groupId: string | undefined;
  if ("source" in input) {
    const message = await readExactQqMessage({ endpoint: selection, kind: input.source.kind, target: input.source.targetId,
      messageId: input.source.messageId, signal, current: selection.assertCurrent, transport: context.transport });
    selection.assertCurrent();
    media = qqMessageMedia(message.message)[input.source.attachmentIndex];
    if (input.source.kind === "group") groupId = input.source.targetId;
  } else {
    assertSourceGroupFileAccess(context, selection, input.group.groupId);
    groupId = input.group.groupId;
    // Native owns this expiring GroupFS cache reference and group resource permission.
    // Re-listing would issue a different random key, not prove this key's identity.
    media = { kind: "file", name: "group-file.bin", file: input.group.fileId };
  }
  if (!media || media.kind !== "file") throw new NapcatApiError(422, "QQ_RESOURCE_KIND_MISMATCH");
  // The exact native message converter caches its native UUID; GroupFS lists
  // cache model IDs under a separate opaque public key. Neither is a host path.
  if (!media.file || media.file.length > 4096 || /[\x00-\x1f\x7f]/.test(media.file)) throw new NapcatApiError(422, "QQ_MEDIA_REFERENCE_UNAVAILABLE");
  const nativeResult = await resolveQqSourceFile(selection, media, groupId
    ? { kind: "group", targetId: groupId } : { kind: "private", targetId: (input as SourceInput).source.targetId }, signal, context.transport);
  selection.assertCurrent();
  return { selection, media, nativeResult };
}

async function verifyCompletedSource(context: NapcatApiTransportContext, selection: NapcatApiSelection, input: SourceFileInput, signal: AbortSignal) {
  selection.assertCurrent();
  await verifyNapcatApiIdentity(context, selection, signal);
  selection.assertCurrent();
  if ("group" in input) assertSourceGroupFileAccess(context, selection, input.group.groupId);
}

export async function readSourceFile(context: NapcatApiTransportContext, request: IncomingMessage, input: SourceFileInput, signal: AbortSignal): Promise<SourceFileResult> {
  const { selection, media, nativeResult } = await resolveSourceFile(context, request, input, signal);
  const bytes = await readResolvedQqMediaBytes({ url: nativeResult.url }, { ...media, url: undefined }, signal, context.transport, { mode: "url-only", allowEmptyFile: true });
  await verifyCompletedSource(context, selection, input, signal);
  return { bytes, name: media.name, sha256: createHash("sha256").update(bytes).digest("hex"), nativeContractEquivalent: false };
}

export type SourceFileHashInput = SourceFileInput & { expectedSize: number; expectedSha256: string };
export async function verifySourceFileSha256(context: NapcatApiTransportContext, request: IncomingMessage, input: SourceFileHashInput, signal: AbortSignal) {
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0 || !/^[a-fA-F0-9]{64}$/.test(input.expectedSha256)) {
    throw new NapcatApiError(400, "QQ_FILE_HASH_INPUT_INVALID");
  }
  const { selection, nativeResult } = await resolveSourceFile(context, request, input, signal);
  const hash = createHash("sha256");
  const response = await (context.transport ?? fetch)(resolvedQqMediaUrl(nativeResult.url), { signal, redirect: "follow" });
  const actualSize = await consumeBoundedQqBytes(response, input.expectedSize, chunk => {
    signal.throwIfAborted();
    selection.assertCurrent();
    hash.update(chunk);
  }, signal, undefined, true);
  if (actualSize !== input.expectedSize) throw new NapcatApiError(409, "QQ_FILE_SIZE_MISMATCH");
  await verifyCompletedSource(context, selection, input, signal);
  signal.throwIfAborted();
  const sha256 = hash.digest("hex");
  return { actualSize, sha256, expectedSize: input.expectedSize, sizeMatches: true,
    sha256Matches: sha256 === input.expectedSha256.toLowerCase(),
    source: { routeId: input.routeId, instanceId: input.instanceId, ...("group" in input ? { group: input.group } : { source: input.source }) },
    nativeContractEquivalent: false, receiptUpdated: false };
}

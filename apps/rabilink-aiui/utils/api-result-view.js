import { splitKnowledgeText } from './knowledge-result-view.js';
/** Display arbitrary public API data as bounded plain text, never HTML or executable guidance. */
export function formatApiResult(result) {
  const receipt = result?.structuredContent;
  if (!receipt || receipt.ok !== true || receipt.uncertain || result.isError) return { confirmed: false, pages: [], truncated: false };
  const data = receipt.data?.bodyBase64 !== undefined
    ? { contentType: receipt.data.contentType, encodedBytes: receipt.data.bodyBase64.length, binaryResponse: true }
    : receipt.data;
  const raw = JSON.stringify({ statusCode: receipt.statusCode, operationId: receipt.operationId, headers: receipt.headers, data }, null, 2);
  const clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return { confirmed: true, pages: splitKnowledgeText(clean.slice(0, 12000)), truncated: clean.length > 12000 };
}

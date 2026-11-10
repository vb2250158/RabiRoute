/** Decode finite JSON once while preserving original uncertainty and receipt metadata. */
export function decodeManagerJsonReceipt(receipt) {
  let value = receipt.bodyJson;
  if (value === undefined) {
    const type = receipt.headers?.['content-type'] ?? '';
    const raw = typeof receipt.body === 'string' ? receipt.body : /(?:^application\/json\b|\+json\b)/i.test(type) && receipt.bodyBytes !== undefined ? new TextDecoder().decode(receipt.bodyBytes) : undefined;
    if (raw !== undefined) { try { value = JSON.parse(raw); } catch { /* Text and bytes keep their original representation. */ } }
  }
  if (value === undefined) return receipt;
  const uncertain = Boolean(receipt.uncertain || value?.uncertain === true || value?.mutationOutcome === 'unknown' || value?.commitState === 'unknown');
  return { ...receipt, bodyJson: value, uncertain, ok: receipt.ok === true && value?.code !== -1 && value?.ok !== false && !uncertain };
}

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


const mediaProjection = Symbol('Manager receipt media projection');
const mediaExtension = 'x-rabiroute-media';
// The padding groups also check unused bits without allocating a decoded copy.
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined;
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function pointerParts(path) {
  if (typeof path !== 'string' || path !== '' && !path.startsWith('/') || /~(?:[^01]|$)/.test(path)) return undefined;
  return path === '' ? [] : path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerValue(value, parts) {
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function replacePointer(value, parts, replacement, copies) {
  if (!parts.length) return replacement;
  const parents = [value];
  for (const part of parts.slice(0, -1)) parents.push(parents.at(-1)[part]);
  let result = replacement;
  for (let index = parts.length - 1; index >= 0; index--) {
    const parent = parents[index];
    let copy = copies.get(parent);
    if (!copy) {
      copy = Array.isArray(parent) ? [...parent] : { ...parent };
      copies.set(parent, copy);
      copies.set(copy, copy);
    }
    Object.defineProperty(copy, parts[index], { value: result, enumerable: true, configurable: true, writable: true });
    result = copy;
  }
  return result;
}

function imageError(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return 'IMAGE_OBJECT_REQUIRED';
  if (typeof image.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) return 'IMAGE_MIME_TYPE_INVALID';
  if (typeof image.data !== 'string' || !image.data.length || !canonicalBase64.test(image.data)) return 'IMAGE_BASE64_INVALID';
  if (['width', 'height'].some(key => image[key] !== undefined && (!Number.isSafeInteger(image[key]) || image[key] < 1))) return 'IMAGE_DIMENSIONS_INVALID';
}

/** Project only explicitly declared JSON images or an HTTP image body. Never executes or retries an operation. */
export function projectManagerReceiptMedia(receipt, contract) {
  if (receipt[mediaProjection]) return receipt;
  const decoded = decodeManagerJsonReceipt(receipt);
  const response = contract?.responses?.[String(receipt.statusCode)] ?? contract?.responses?.default;
  const header = headerValue(receipt.headers, mediaExtension);
  let declarations = response?.schema?.[mediaExtension] ?? response?.[mediaExtension];
  const errors = [];
  if (header !== undefined) {
    try { declarations = JSON.parse(header); }
    catch { errors.push({ code: 'MEDIA_DECLARATION_INVALID', source: 'header' }); declarations = undefined; }
  }
  if (declarations !== undefined && !Array.isArray(declarations)) {
    errors.push({ code: 'MEDIA_DECLARATION_INVALID', source: header === undefined ? 'schema' : 'header' });
    declarations = undefined;
  }
  const media = [], paths = [], visited = new Set();
  const json = decoded.bodyJson;
  for (const [index, entry] of (declarations ?? []).entries()) {
    const parts = pointerParts(entry?.path);
    if (!parts || entry?.type !== 'image' || entry.matchMimeType !== undefined && (typeof entry.matchMimeType !== 'string' || !/^image\/(?:[a-z0-9.+-]+|\*)$/i.test(entry.matchMimeType))) {
      errors.push({ code: 'MEDIA_ENTRY_INVALID', ...(typeof entry?.path === 'string' ? { path: entry.path } : {}) });
      continue;
    }
    if (visited.has(entry.path)) continue;
    const image = pointerValue(json, parts);
    if (image === undefined) continue;
    if (entry.matchMimeType !== undefined) {
      const matches = entry.matchMimeType.toLowerCase() === 'image/*'
        ? typeof image?.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(image.mimeType)
        : typeof image?.mimeType === 'string' && image.mimeType.toLowerCase() === entry.matchMimeType.toLowerCase();
      if (!matches) continue;
    }
    const error = imageError(image);
    const imageItemId = image?.imageItemId === undefined ? `image-${index + 1}` : image.imageItemId;
    if (error) { errors.push({ code: error, path: entry.path, imageItemId }); continue; }
    visited.add(entry.path);
    paths.push({ parts, imageItemId });
    const { mimeType, data, width, height, frameId, source, transform } = image;
    media.push({ type: 'image', mimeType, data, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
      ...(frameId === undefined ? {} : { frameId }), ...(source === undefined ? {} : { source }),
      ...(transform === undefined ? {} : { transform }), imageItemId });
  }
  const mimeType = String(headerValue(receipt.headers, 'content-type') ?? '').split(';', 1)[0].trim();
  let rawImage = false;
  if (/^image\/[a-z0-9.+-]+$/i.test(mimeType) && declarations === undefined && errors.length === 0) {
    const data = receipt.bodyBytes === undefined ? receipt.bodyBase64 : encodeReceiptBytes(receipt.bodyBytes);
    const image = { type: 'image', mimeType, data, imageItemId: 'image-1' };
    const error = imageError(image);
    if (error) errors.push({ code: error, imageItemId: image.imageItemId });
    else { media.push(image); rawImage = true; }
  }
  if (!media.length && !errors.length && !paths.length) return { ...decoded };
  const projected = { ...decoded, media, ...(errors.length ? { mediaErrors: errors } : {}) };
  // Symbols survive the existing receipt spreads while staying outside JSON and protocol output.
  projected[mediaProjection] = { rawReceipt: receipt, paths, rawImage };
  return projected;
}

function encodeReceiptBytes(value) {
  if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64');
  let text = '';
  for (const byte of value instanceof ArrayBuffer ? new Uint8Array(value) : value) text += String.fromCharCode(byte);
  return btoa(text);
}

/** The untouched transport receipt remains available to local diagnostics. */
export function getRawManagerReceipt(receipt) {
  return receipt[mediaProjection]?.rawReceipt ?? receipt;
}

/** Public receipt descriptors share identity with image content without repeating image bytes. */
export function compactManagerReceiptMedia(receipt) {
  const projection = receipt[mediaProjection];
  if (!projection) return receipt;
  const compact = { ...receipt, media: receipt.media.map(({ data, ...descriptor }) => descriptor) };
  delete compact[mediaProjection];
  if (projection.rawImage || projection.paths.length) {
    delete compact.body;
    delete compact.bodyBytes;
    delete compact.bodyBase64;
  }
  for (const name of ['bodyJson', 'data']) {
    let value = compact[name];
    if (value === undefined) continue;
    const copies = new WeakMap();
    for (const { parts, imageItemId } of projection.paths) {
      const image = pointerValue(value, parts);
      if (!image || typeof image !== 'object' || Array.isArray(image)) continue;
      const { data, ...descriptor } = image;
      value = replacePointer(value, parts, { ...descriptor, imageItemId }, copies);
    }
    compact[name] = value;
  }
  return compact;
}

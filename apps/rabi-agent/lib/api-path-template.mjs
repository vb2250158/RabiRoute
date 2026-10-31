/** Shared by the executable registrar, OpenAPI and the signed generic connector. */
export function validApiHttpMethod(method) {
  return typeof method === "string" && method !== "*" && /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method);
}

// Registration compares each template with many earlier routes. Retain only
// immutable derived metadata; public callers receive their own mutable RegExp.
const templateMetadata = new Map();
const maximumCachedTemplates = 1024, maximumCacheKeyLength = 4096;

function apiPathMetadata(template, tailNames = [], remainderName = "", caseInsensitiveLiterals = []) {
  if (!Array.isArray(caseInsensitiveLiterals) || new Set(caseInsensitiveLiterals).size !== caseInsensitiveLiterals.length
    || caseInsensitiveLiterals.some(value => typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(value))) throw new Error("Invalid case-insensitive API path literals.");
  if (!Array.isArray(tailNames) || new Set(tailNames).size !== tailNames.length || tailNames.some(name => typeof name !== "string")) throw new Error("Invalid API path tail binding.");
  if (typeof template !== "string" || !template.startsWith("/") || /[?#\\\s]/.test(template) || template.startsWith("//")) throw new Error("Invalid API path template.");
  if (typeof remainderName !== "string" || remainderName && !/^[A-Za-z][A-Za-z0-9_]*$/.test(remainderName) || tailNames.includes(remainderName)) throw new Error("Invalid raw API path remainder binding.");
  const key = JSON.stringify([template, [...tailNames], remainderName, [...caseInsensitiveLiterals]]);
  const cached = templateMetadata.get(key);
  if (cached) return cached;
  const names = [], tails = [];
  const parts = template.split("/");
  const segments = parts.map((value, index) => {
    // A raw suffix may begin inside the last literal segment (for native startsWith routes).
    // Binding it explicitly avoids silently widening ordinary parameter templates.
    const suffix = remainderName && index === parts.length - 1 && value.endsWith(`:${remainderName}`)
      ? value.slice(0, -remainderName.length - 1) : "";
    if (suffix) {
      if (suffix.includes(":") || names.includes(remainderName) || caseInsensitiveLiterals.length) throw new Error("Invalid raw API prefix binding.");
      names.push(remainderName);
      return Object.freeze({ name: remainderName, tail: false, remainder: true, prefix: suffix });
    }
    if (value.startsWith(":")) {
      const match = /^:([A-Za-z][A-Za-z0-9_]*)$/.exec(value);
      if (!match || names.includes(match[1]) || (tailNames.includes(match[1]) || match[1] === remainderName) && index !== parts.length - 1) throw new Error("Invalid or duplicate API path parameter.");
      const name = match[1], tail = tailNames.includes(name), remainder = name === remainderName; names.push(name); if (tail) tails.push(name);
      return Object.freeze({ name, tail, remainder });
    }
    if (value === "." || value === "..") throw new Error("Invalid API path segment.");
    return Object.freeze({ literal: value, ...(caseInsensitiveLiterals.includes(value) ? { caseInsensitive: true } : {}) });
  });
  if (tailNames.some(name => !names.includes(name))) throw new Error("Unknown API path tail binding.");
  if (remainderName && !names.includes(remainderName)) throw new Error("Unknown API path remainder binding.");
  if (caseInsensitiveLiterals.some(value => !segments.some(segment => segment.literal === value))) throw new Error("Unknown case-insensitive API path literal.");
  const patternSource = "^" + segments.map(segment => segment.name
    ? segment.remainder ? (segment.prefix ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.*)" : segment.tail ? "([^/]+(?:/[^/]+)*)" : "([^/]+)"
    : segment.literal.split("").map(character => segment.caseInsensitive && /[A-Za-z]/.test(character)
      ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")).join("/") + "$";
  const metadata = Object.freeze({ names: Object.freeze(names), tails: Object.freeze(tails), remainder: remainderName || undefined, segments: Object.freeze(segments), patternSource,
    openApiTemplate: segments.map(segment => segment.name ? `${segment.prefix ?? ""}{${segment.name}}` : segment.literal).join("/") });
  if (key.length <= maximumCacheKeyLength) {
    if (templateMetadata.size >= maximumCachedTemplates) templateMetadata.delete(templateMetadata.keys().next().value);
    templateMetadata.set(key, metadata);
  }
  return metadata;
}

export function parseApiPathTemplate(template, tailNames = [], remainderName = "", caseInsensitiveLiterals = []) {
  const { patternSource, ...metadata } = apiPathMetadata(template, tailNames, remainderName, caseInsensitiveLiterals);
  return Object.freeze({ ...metadata, pattern: new RegExp(patternSource) });
}

export function validApiTail(value) {
  return typeof value === "string" && !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function fillApiPathTemplate(template, values = {}, tailNames = [], remainderName = "") {
  const parsed = apiPathMetadata(template, tailNames, remainderName);
  if (Object.keys(values).some(name => !parsed.names.includes(name))) throw new Error("Unexpected API path parameter.");
  return parsed.segments.map(segment => {
    if (!segment.name) return segment.literal;
    const value = values[segment.name];
    if (segment.remainder) {
      if (typeof value !== "string" || /[?#\\\u0000-\u0020\u007f]/.test(value)) throw new Error("Invalid raw API path remainder.");
      return (segment.prefix ?? "") + value;
    }
    if (!["string", "number"].includes(typeof value) || !String(value) || [".", ".."].includes(String(value))) throw new Error("A required API path parameter is missing or invalid.");
    if (!segment.tail) return encodeURIComponent(String(value));
    if (!validApiTail(String(value))) throw new Error("Invalid multi-segment API path parameter.");
    return String(value).split("/").map(encodeURIComponent).join("/");
  }).join("/");
}

/** Callers use this for tail captures; existing literal/parameter precedence is unchanged. */
export function apiTailPathsOverlap(left, right, leftTails = [], rightTails = [], leftRemainder = "", rightRemainder = "", leftCase = [], rightCase = []) {
  if (!leftTails.length && !rightTails.length && !leftRemainder && !rightRemainder) return false;
  const a = apiPathMetadata(left, leftTails, leftRemainder, leftCase), b = apiPathMetadata(right, rightTails, rightRemainder, rightCase);
  for (let index = 0; index < Math.max(a.segments.length, b.segments.length); index++) {
    const x = a.segments[index], y = b.segments[index];
    if (!x || !y) return false;
    if (x.remainder && x.prefix || y.remainder && y.prefix) {
      const prefix = x.prefix ?? y.prefix, other = x.prefix ? y : x;
      return other.literal !== undefined ? (other.caseInsensitive ? other.literal.toLowerCase().startsWith(prefix.toLowerCase()) : other.literal.startsWith(prefix))
        : other.prefix ? other.prefix.startsWith(prefix) || prefix.startsWith(other.prefix) : true;
    }
    if (x.tail || y.tail || x.remainder || y.remainder) return true;
    if (x.literal !== undefined && y.literal !== undefined && (x.caseInsensitive || y.caseInsensitive ? x.literal.toLowerCase() !== y.literal.toLowerCase() : x.literal !== y.literal)) return false;
  }
  return true;
}

/** Parameter positions stay equivalent; only explicitly declared literal segments fold case. */
export function apiPathTemplatesEquivalent(left, right, leftCase = [], rightCase = []) {
  const a = apiPathMetadata(left, [], "", leftCase), b = apiPathMetadata(right, [], "", rightCase);
  return a.segments.length === b.segments.length && a.segments.every((x, index) => {
    const y = b.segments[index];
    if (x.name || y.name) return Boolean(x.name && y.name);
    return x.caseInsensitive || y.caseInsensitive ? x.literal.toLowerCase() === y.literal.toLowerCase() : x.literal === y.literal;
  });
}

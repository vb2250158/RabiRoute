import { Marked } from "marked";

export const PLAN_MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const PERSONA_DOCUMENT_MAX_BYTES = PLAN_MARKDOWN_PREVIEW_MAX_BYTES;
export const PLAN_MARKDOWN_TEASER_READ_BYTES = 12 * 1024;

export async function responseTextByByteLimit(
  response: Response,
  byteLimit: number,
  truncate: boolean,
  overflowMessage = ""
): Promise<string> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!truncate && bytes.byteLength > byteLimit) throw new Error(overflowMessage);
    return new TextDecoder().decode(bytes.subarray(0, byteLimit));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let source = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = byteLimit - byteCount;
      if (remaining <= 0) {
        await reader.cancel();
        if (!truncate) throw new Error(overflowMessage);
        break;
      }
      if (!truncate && value.byteLength > remaining) {
        await reader.cancel();
        throw new Error(overflowMessage);
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      byteCount += chunk.byteLength;
      source += decoder.decode(chunk, { stream: true });
      if (value.byteLength > remaining) {
        await reader.cancel();
        break;
      }
      if (truncate && byteCount >= byteLimit) {
        await reader.cancel();
        break;
      }
    }
    source += decoder.decode();
    return source;
  } finally {
    reader.releaseLock();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] || character);
}

export function safeMarkdownHref(value: string): string {
  const href = String(value || "").trim();
  if (href.startsWith("#")) return href;
  const protocol = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return protocol && ["http", "https", "mailto"].includes(protocol) ? href : "";
}

function safeMarkdownImageHref(value: string): string {
  const href = String(value || "").trim();
  const protocol = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return protocol && ["http", "https"].includes(protocol) ? href : "";
}

export function isPlanMarkdownAttachment(name: string, mimeType?: string): boolean {
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  return /\.(?:md|markdown|mdown|mkd)$/i.test(String(name || "").trim())
    || normalizedMimeType === "text/markdown"
    || normalizedMimeType === "text/x-markdown";
}

export function markdownPreviewExcerpt(source: string, maxLength = 180): string {
  const normalized = String(source || "")
    .replace(/^\uFEFF/, "")
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[|*_~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export const planMarkdownPreviewExcerpt = markdownPreviewExcerpt;

const planMarkdownRenderer = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safeHref = safeMarkdownHref(href);
      if (!safeHref) return `<span class="markdown-preview-disabled-link">${label}</span>`;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${label}</a>`;
    },
    image({ text }) {
      const label = escapeHtml(String(text || "image"));
      return `<span class="markdown-preview-image-placeholder">IMAGE · ${label}</span>`;
    }
  }
});

const memoryMarkdownRenderer = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safeHref = safeMarkdownHref(href);
      if (!safeHref) return `<span class="markdown-preview-disabled-link">${label}</span>`;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${label}</a>`;
    },
    image({ href, title, text }) {
      const label = escapeHtml(String(text || "image"));
      const safeHref = safeMarkdownImageHref(href);
      if (!safeHref) return `<span class="markdown-preview-image-placeholder">IMAGE · ${label}</span>`;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(safeHref)}" alt="${label}" loading="lazy" referrerpolicy="no-referrer"${titleAttribute}>`;
    }
  }
});

export function renderMarkdownPreview(source: string): string {
  return planMarkdownRenderer.parse(String(source || ""), { async: false });
}

export function renderMemoryMarkdownPreview(source: string): string {
  return memoryMarkdownRenderer.parse(String(source || ""), { async: false });
}

export const renderPlanMarkdownPreview = renderMarkdownPreview;

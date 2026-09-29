// Tool records are untrusted text. This module never renders HTML or executes content.
const FIELDS = ["id", "title", "name", "focus", "content", "detail", "summary", "description", "status", "nextAction"];
const COLLECTIONS = ["items", "plans", "memories", "results", "statuses", "recent", "consolidated"];
export function splitKnowledgeText(value, budget = 50) {
  const pages = []; let page = "", width = 0;
  for (const character of String(value)) {
    const cost = /[\x20-\x7e]/.test(character) ? 1 : 2;
    if (width + cost > budget && page) { pages.push(page); page = ""; width = 0; }
    page += character; width += cost;
  }
  if (page) pages.push(page);
  return pages;
}
export function formatKnowledgeResult(result) {
  const receipt = result && result.structuredContent;
  if (!receipt || receipt.ok !== true || receipt.uncertain === true || result.isError === true) return { confirmed: false, pages: [], truncated: false };
  const data = receipt.data;
  let rows;
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === "object") {
    rows = [];
    for (const key of COLLECTIONS) if (Array.isArray(data[key])) rows = rows.concat(data[key]);
    if (!rows.length && !COLLECTIONS.some(key => Array.isArray(data[key]))) rows = [data];
  } else rows = [];
  const pages = []; let remaining = 12000, truncated = rows.length > 20;
  for (const row of rows.slice(0, 20)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const fields = [];
    for (const key of FIELDS) if (typeof row[key] === "string" && row[key].trim()) {
      const clean = row[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
      if (!fields.includes(clean)) fields.push(clean);
    }
    const text = fields.join("；");
    if (!text) continue;
    const characters = Array.from(text);
    if (characters.length > remaining) truncated = true;
    const bounded = characters.slice(0, remaining).join(""); remaining -= Array.from(bounded).length;
    pages.push(...splitKnowledgeText(bounded));
    if (!remaining) { truncated = true; break; }
  }
  return { confirmed: true, pages, truncated };
}

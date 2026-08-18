import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeLanguageStyleBinding } from "./shared/languageStyle.js";

export type LanguageStyleValidationRequest = {
  text: unknown;
  styleSkillUrl: unknown;
  scope?: unknown;
  prompt?: unknown;
};

export type LanguageStyleViolation = {
  ruleId: string;
  level: "error" | "warning";
  paragraph: number;
  message: string;
  evidence: string;
};

export type LanguageStyleValidationResult = {
  passed: boolean;
  status: "passed" | "failed" | "unavailable";
  styleSkillUrl: string;
  styleDataUrl?: string;
  targetLanguage?: string;
  scope: string;
  violations: LanguageStyleViolation[];
  checkedRuleIds: string[];
  skippedRuleIds: string[];
  error?: string;
};

type StyleCheck = {
  id?: unknown;
  level?: unknown;
  scope?: unknown;
  kind?: unknown;
  values?: unknown;
  patterns?: unknown;
  message?: unknown;
  allowWhenPromptAsksBoundary?: unknown;
  allowWhenPromptAsksReason?: unknown;
  similarityThreshold?: unknown;
  language?: unknown;
};

type StyleData = {
  runtimeConstraints?: {
    targetLanguage?: unknown;
    checks?: unknown;
  };
};

const MAX_STYLE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_SCOPE = "outbound_message";
const SUPPORTED_CHECK_KINDS = new Set([
  "forbidden_phrases",
  "unasked_negative_exclusion",
  "simple_answer_has_extra_sentences",
  "duplicate_paragraph",
  "target_language",
  "redundant_first_person_execution"
]);

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} exceeds ${maximum} characters.`);
  return text;
}

function normalizedScope(value: unknown): string {
  const scope = value == null ? DEFAULT_SCOPE : requiredText(value, "scope", 80);
  if (!/^[a-z][a-z0-9_-]*$/i.test(scope)) throw new Error("scope must be a stable identifier.");
  return scope;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
}

function normalizeStyleUrl(value: unknown): URL {
  const raw = normalizeLanguageStyleBinding({ styleSkillUrl: value })?.styleSkillUrl as string;
  if (/^[A-Za-z]:[\\/]/.test(raw) || path.isAbsolute(raw) || !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return pathToFileURL(path.resolve(raw));
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("styleSkillUrl must be a file, HTTPS, or loopback HTTP URL.");
  }
  if (url.protocol === "file:" || url.protocol === "https:") return url;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())) {
    return url;
  }
  throw new Error("styleSkillUrl must use file:, HTTPS, or loopback HTTP.");
}

function remoteStyleDataUrl(skillUrl: URL): URL {
  const result = new URL(skillUrl.toString());
  const pathname = result.pathname.replace(/\\/g, "/");
  if (/\.json$/i.test(pathname)) return result;
  if (/\/SKILL\.md$/i.test(pathname)) {
    result.pathname = pathname.replace(/\/SKILL\.md$/i, "/references/style-data.json");
    return result;
  }
  result.pathname = `${pathname.replace(/\/+$/, "")}/references/style-data.json`;
  return result;
}

async function localStyleDataUrl(skillUrl: URL): Promise<URL> {
  const localPath = fileURLToPath(skillUrl);
  const stat = await fs.stat(localPath);
  if (stat.isDirectory()) return pathToFileURL(path.join(localPath, "references", "style-data.json"));
  if (/\.json$/i.test(localPath)) return pathToFileURL(localPath);
  if (/SKILL\.md$/i.test(localPath)) return pathToFileURL(path.join(path.dirname(localPath), "references", "style-data.json"));
  throw new Error("Local styleSkillUrl must point to a Skill directory, SKILL.md, or style-data.json.");
}

async function resolveStyleDataUrl(skillUrl: URL): Promise<URL> {
  return skillUrl.protocol === "file:" ? localStyleDataUrl(skillUrl) : remoteStyleDataUrl(skillUrl);
}

async function readStyleData(url: URL): Promise<StyleData> {
  let text: string;
  if (url.protocol === "file:") {
    const localPath = fileURLToPath(url);
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) throw new Error("Style data URL does not point to a file.");
    if (stat.size > MAX_STYLE_BYTES) throw new Error(`Style data exceeds ${MAX_STYLE_BYTES} bytes.`);
    text = await fs.readFile(localPath, "utf8");
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error(`Style data request failed with HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get("content-length") || "0");
      if (declaredLength > MAX_STYLE_BYTES) throw new Error(`Style data exceeds ${MAX_STYLE_BYTES} bytes.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_STYLE_BYTES) throw new Error(`Style data exceeds ${MAX_STYLE_BYTES} bytes.`);
      text = bytes.toString("utf8");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Style data request timed out after ${FETCH_TIMEOUT_MS} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  const parsed = JSON.parse(text) as StyleData;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runtimeConstraints?.checks)) {
    throw new Error("Style data must contain runtimeConstraints.checks.");
  }
  return parsed;
}

function paragraphIndex(text: string, offset: number): number {
  return text.slice(0, offset).split(/\n\s*\n/).length;
}

function stripProtectedText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z]:\\[^\s]+/g, " ")
    .replace(/\/[\w./-]+/g, " ");
}

function sentenceCount(text: string): number {
  return stripProtectedText(text).split(/[。！？!?]+/).map(item => item.trim()).filter(Boolean).length;
}

function bigrams(text: string): Set<string> {
  const normalized = text.replace(/[\s\p{P}\p{S}]/gu, "");
  const values = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) values.add(normalized.slice(index, index + 2));
  return values;
}

function similarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function promptFlags(prompt: string): { asksReason: boolean; asksBoundary: boolean; simpleStatusQuestion: boolean } {
  return {
    asksReason: /为什么|原因|解释|说明一下|怎么回事|如何|依据/.test(prompt),
    asksBoundary: /是否意味着|等于|代表|能否说明|能不能说明|通过了吗|失败了吗|边界|排除/.test(prompt),
    simpleStatusQuestion: prompt.length <= 80
      && /(?:吗|么|没|没有|是否|是不是|有没有|完成|更新|通过|成功|失败|好了)[？?]?$/.test(prompt)
      && !/为什么|原因|解释|如何|怎么/.test(prompt)
  };
}

function appliesToScope(check: StyleCheck, scope: string): boolean {
  const scopes = stringList(check.scope);
  if (scopes.length === 0 || scopes.includes(scope)) return true;
  return scope === "outbound_message" && scopes.includes("final");
}

function violation(check: StyleCheck, paragraph: number, evidence: string): LanguageStyleViolation {
  return {
    ruleId: String(check.id || "STYLE-RULE"),
    level: check.level === "warning" ? "warning" : "error",
    paragraph,
    message: String(check.message || "Language style rule failed."),
    evidence
  };
}

function runChecks(text: string, prompt: string, scope: string, checks: StyleCheck[]): {
  violations: LanguageStyleViolation[];
  checkedRuleIds: string[];
  skippedRuleIds: string[];
} {
  const violations: LanguageStyleViolation[] = [];
  const checkedRuleIds: string[] = [];
  const skippedRuleIds: string[] = [];
  const flags = promptFlags(prompt);
  for (const check of checks) {
    const ruleId = String(check.id || "STYLE-RULE");
    const kind = String(check.kind || "");
    if (!appliesToScope(check, scope) || !SUPPORTED_CHECK_KINDS.has(kind)) {
      skippedRuleIds.push(ruleId);
      continue;
    }
    if (kind === "unasked_negative_exclusion" && check.allowWhenPromptAsksBoundary === true && !prompt) {
      skippedRuleIds.push(ruleId);
      continue;
    }
    if (kind === "simple_answer_has_extra_sentences" && !prompt) {
      skippedRuleIds.push(ruleId);
      continue;
    }
    checkedRuleIds.push(ruleId);
    if (kind === "forbidden_phrases") {
      for (const phrase of stringList(check.values)) {
        const offset = text.indexOf(phrase);
        if (offset >= 0) violations.push(violation(check, paragraphIndex(text, offset), phrase));
      }
    } else if (kind === "unasked_negative_exclusion") {
      if (check.allowWhenPromptAsksBoundary === true && flags.asksBoundary) continue;
      for (const phrase of stringList(check.patterns)) {
        const offset = text.indexOf(phrase);
        if (offset >= 0) violations.push(violation(check, paragraphIndex(text, offset), phrase));
      }
    } else if (kind === "simple_answer_has_extra_sentences") {
      if (flags.simpleStatusQuestion && !(check.allowWhenPromptAsksReason === true && flags.asksReason) && sentenceCount(text) > 1) {
        violations.push(violation(check, 1, "短答包含多句"));
      }
    } else if (kind === "duplicate_paragraph") {
      const paragraphs = stripProtectedText(text).split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
      const threshold = Number(check.similarityThreshold ?? 0.72);
      for (let left = 0; left < paragraphs.length; left += 1) {
        for (let right = left + 1; right < paragraphs.length; right += 1) {
          if (similarity(paragraphs[left], paragraphs[right]) >= threshold) {
            violations.push(violation(check, right + 1, `与第 ${left + 1} 段重复`));
          }
        }
      }
    } else if (kind === "target_language" && String(check.language || "").toLowerCase().startsWith("zh")) {
      const plain = stripProtectedText(text);
      const han = (plain.match(/[\p{Script=Han}]/gu) ?? []).length;
      const latinWords = (plain.match(/[A-Za-z]{2,}/g) ?? []).length;
      if (latinWords >= 8 && han < latinWords * 2) violations.push(violation(check, 1, "英文自然语言占比过高"));
    } else if (kind === "redundant_first_person_execution") {
      for (const phrase of stringList(check.patterns)) {
        const offset = text.indexOf(phrase);
        if (offset >= 0) violations.push(violation(check, paragraphIndex(text, offset), phrase));
      }
    }
  }
  return { violations, checkedRuleIds, skippedRuleIds };
}

export class LanguageStyleValidator {
  async validate(request: LanguageStyleValidationRequest): Promise<LanguageStyleValidationResult> {
    const text = requiredText(request.text, "text", MAX_TEXT_CHARS);
    const skillUrl = normalizeStyleUrl(request.styleSkillUrl);
    const scope = normalizedScope(request.scope);
    const prompt = request.prompt == null ? "" : String(request.prompt).slice(0, MAX_TEXT_CHARS);
    const base = {
      styleSkillUrl: skillUrl.toString(),
      scope,
      violations: [] as LanguageStyleViolation[],
      checkedRuleIds: [] as string[],
      skippedRuleIds: [] as string[]
    };
    try {
      const styleDataUrl = await resolveStyleDataUrl(skillUrl);
      const styleData = await readStyleData(styleDataUrl);
      const checks = styleData.runtimeConstraints?.checks as StyleCheck[];
      const result = runChecks(text, prompt, scope, checks);
      return {
        ...base,
        ...result,
        passed: result.violations.length === 0,
        status: result.violations.length === 0 ? "passed" : "failed",
        styleDataUrl: styleDataUrl.toString(),
        targetLanguage: typeof styleData.runtimeConstraints?.targetLanguage === "string"
          ? styleData.runtimeConstraints.targetLanguage
          : undefined
      };
    } catch (error) {
      return {
        ...base,
        passed: false,
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
        violations: [{
          ruleId: "STYLE-SOURCE",
          level: "error",
          paragraph: 1,
          message: "目标语言风格无法读取或解析。",
          evidence: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  }
}

export type StyleValidationMode = 0 | 1;

export type LanguageStyleBinding = {
  styleSkillUrl: string;
};

export function normalizeStyleValidationMode(value: unknown): StyleValidationMode {
  if (value == null) return 1;
  if (value === 0 || value === 1) return value;
  throw new Error("styleValidation must be 1 (validate) or 0 (skip validation).");
}

export function normalizeLanguageStyleBinding(value: unknown): LanguageStyleBinding | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("languageStyle must be an object.");
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(key => key !== "styleSkillUrl");
  if (unexpected.length > 0) throw new Error(`languageStyle contains unsupported fields: ${unexpected.join(", ")}.`);
  const styleSkillUrl = typeof record.styleSkillUrl === "string" ? record.styleSkillUrl.trim() : "";
  if (!styleSkillUrl) throw new Error("languageStyle.styleSkillUrl is required.");
  if (styleSkillUrl.length > 4_096 || /[\u0000-\u001f\u007f]/.test(styleSkillUrl)) {
    throw new Error("languageStyle.styleSkillUrl is invalid.");
  }
  return { styleSkillUrl };
}

import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { LANGUAGE_STYLE_VALIDATION_LIMITS as limits, LANGUAGE_STYLE_VALIDATION_STATUSES, LANGUAGE_STYLE_VIOLATION_LEVELS,
  type LanguageStyleValidator, type LanguageStyleValidationRequest } from "../languageStyleValidation.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";

/** Transport declarations reuse the existing style owner; no rules or style content are copied here. */
export function createLanguageStyleOperations(validator: Pick<LanguageStyleValidator, "validate">): readonly ApiOperationDefinition[] {
  return [{ contract: {
    operationId: "manager.language-style.validate", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/language-style/validate",
    description: "Validate text against the selected style source using its existing normalization, source loading and check owner. Unavailable style sources are successful results with status=unavailable.",
    exposure: "public", transport: "http",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" }, body: {
      kind: "json", maxBytes: limits.requestBytes, allowAnyContentType: true,
      schema: { type: "object", required: ["text", "styleSkillUrl"], additionalProperties: true, properties: {
        text: { type: "string" }, styleSkillUrl: { type: "string" }, scope: { anyOf: [{ type: "string" }, { type: "null" }] }, prompt: true
      } }
    } },
    responses: {
      "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "data"], additionalProperties: false, properties: {
        code: { const: 0 }, data: { type: "object", required: ["passed", "status", "styleSkillUrl", "scope", "violations", "checkedRuleIds", "skippedRuleIds"], additionalProperties: false, properties: {
          passed: { type: "boolean" }, status: { enum: LANGUAGE_STYLE_VALIDATION_STATUSES }, styleSkillUrl: { type: "string" }, styleDataUrl: { type: "string" },
          targetLanguage: { type: "string" }, scope: { type: "string" }, error: { type: "string" },
          violations: { type: "array", items: { type: "object", required: ["ruleId", "level", "paragraph", "message", "evidence"], additionalProperties: false, properties: {
            ruleId: { type: "string" }, level: { enum: LANGUAGE_STYLE_VIOLATION_LEVELS }, paragraph: { type: "integer", minimum: 1 }, message: { type: "string" }, evidence: { type: "string" }
          } } }, checkedRuleIds: { type: "array", items: { type: "string" } }, skippedRuleIds: { type: "array", items: { type: "string" } }
        } }
      } } },
      "400": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" } }, additionalProperties: true } }
    },
    effects: { mode: "read", description: "Loads the requested style data and evaluates text. Does not modify the style binding, persona, rules or source files." },
    recovery: { strategy: "repeatable-read", description: "Repeat with the same source, scope and text after source recovery; do not replace the configured style implicitly." },
    validators: [
      { id: "style-request-normalization", description: `The native owner trims text and enforces ${limits.textChars} UTF-16 code units; scope defaults to ${limits.defaultScope}, is trimmed to at most ${limits.scopeChars} code units and must be an identifier. Prompt retains native String coercion and clipping to ${limits.textChars} code units.` },
      { id: "style-source-owner", description: `The original binding normalizer owns trimming and control-character checks; sources are Manager-host paths, file URLs, HTTPS or loopback HTTP. Native style data validation retains its ${limits.styleBytes}-byte source limit and ${limits.fetchTimeoutMs}ms remote-fetch timeout; missing or invalid style data returns status=unavailable.` }
    ]
  }, handler: async input => {
    input.signal?.throwIfAborted();
    try {
      const data = await validator.validate(input.body as LanguageStyleValidationRequest);
      input.signal?.throwIfAborted();
      return { status: 200, body: { code: 0, data } };
    } catch (error) {
      input.signal?.throwIfAborted();
      return { status: 400, body: errorResponsePresentation({ code: -1, message: error instanceof Error ? error.message : String(error) }, 400) };
    }
  } }];
}

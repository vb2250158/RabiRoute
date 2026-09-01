import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BUILTIN_INTERFACE_THEME_TEMPLATES, interfaceThemeSemanticTextColors } from "../../src/shared/interfaceThemeContract";

const root = path.resolve(import.meta.dirname, "..");

type CssRule = { selector: string; body: string };

function cssRules(styles: string): CssRule[] {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(),
    body: body!.trim()
  }));
}

function rulesForClass(rules: CssRule[], className: string): CssRule[] {
  const classPattern = new RegExp(`(?:^|[\\s>+~])\\.${className}(?=$|[\\s:>+~.#\\[])`);
  return rules.filter(rule => rule.selector.split(",").some(selector => classPattern.test(selector.trim())));
}

test("each WebGUI theme keeps its CSS tokens and Vuetify colors in its own folder", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const vuetify = fs.readFileSync(path.join(root, "src", "plugins", "vuetify.ts"), "utf8");
  const switchTokens = [
    "rr-switch-track",
    "rr-switch-track-active",
    "rr-switch-thumb",
    "rr-switch-thumb-active",
    "rr-switch-track-shadow",
    "rr-switch-thumb-shadow"
  ];
  const semanticTextTokens = [
    "rr-on-accent-strong",
    "rr-accent-text",
    "rr-success-text",
    "rr-warning-text",
    "rr-error-text",
    "rr-info-text"
  ];

  for (const theme of ["light", "dark"]) {
    const tokenPath = path.join(root, "src", "themes", theme, "tokens.css");
    assert.ok(fs.existsSync(tokenPath));
    assert.ok(fs.existsSync(path.join(root, "src", "themes", theme, "vuetify.ts")));
    assert.match(styles, new RegExp(`themes/${theme}/tokens\.css`));
    const tokens = fs.readFileSync(tokenPath, "utf8");
    for (const token of [...switchTokens, ...semanticTextTokens]) {
      assert.match(tokens, new RegExp(`--${token}\\s*:`), `${theme} theme must own ${token}`);
    }
    const baseTheme = theme as "light" | "dark";
    const semanticText = interfaceThemeSemanticTextColors({
      baseTheme,
      colors: BUILTIN_INTERFACE_THEME_TEMPLATES[baseTheme].colors
    });
    assert.match(
      tokens,
      new RegExp(`--rr-on-accent-strong\\s*:\\s*${semanticText.onAccentStrong}`),
      `${theme} CSS accent foreground must match the shared contract`
    );
    const vuetifyTheme = fs.readFileSync(path.join(root, "src", "themes", theme, "vuetify.ts"), "utf8");
    assert.match(
      vuetifyTheme,
      new RegExp(`"on-accent"\\s*:\\s*"${semanticText.onAccentStrong}"`),
      `${theme} Vuetify accent foreground must match the shared contract`
    );
  }
  assert.match(vuetify, /themes\/light\/vuetify/);
  assert.match(vuetify, /themes\/dark\/vuetify/);
  assert.match(
    styles,
    /\.v-switch \.v-selection-control--dirty \.v-selection-control__input\s*\{[^}]*color:\s*var\(--rr-switch-track-active\)\s*!important/s
  );
  assert.match(
    styles,
    /\.v-switch \.v-selection-control--dirty \.v-switch__track\s*\{[^}]*background:\s*var\(--rr-switch-track-active\)\s*!important/s
  );
  assert.match(
    styles,
    /\.v-switch \.v-selection-control--dirty \.v-switch__thumb\s*\{[^}]*var\(--rr-switch-thumb-active\)/s
  );
});

test("desktop settings expose cloning and a bounded custom theme editor", () => {
  const source = fs.readFileSync(path.join(root, "src", "components", "renderers", "DesktopSettingsRenderer.vue"), "utf8");
  assert.match(source, /添加自定义主题/);
  assert.match(source, /保存并应用/);
  assert.match(source, /INTERFACE_THEME_COLOR_KEYS/);
  assert.match(source, /cornerRadius/);
  assert.match(source, /glassOpacity/);
});


test("theme-bound text and knowledge surfaces use semantic tokens", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const performance = fs.readFileSync(path.join(root, "src", "components", "renderers", "PerformanceStatusRenderer.vue"), "utf8");
  const speech = fs.readFileSync(path.join(root, "src", "components", "renderers", "SpeechStatusRenderer.vue"), "utf8");

  for (const legacy of ["--surface-card", "--shadow-card", "--text-muted", "--rr-danger"]) {
    assert.doesNotMatch(`${styles}\n${performance}\n${speech}`, new RegExp(legacy));
  }
  for (const oldColor of ["#173b55", "#173650", "#29445a", "#536b7e", "#6c7e8d", "#7b8b98", "#8b98a8"]) {
    assert.doesNotMatch(styles, new RegExp(oldColor, "i"), `legacy light-only text color must be removed: ${oldColor}`);
  }
  assert.match(styles, /\.knowledge-plan-attachment-meta b\s*\{[^}]*color:\s*var\(--rr-heading\)/s);
  assert.match(styles, /\.knowledge-plan-attachment-meta small\s*\{[^}]*color:\s*var\(--rr-muted\)/s);
  assert.match(styles, /\.knowledge-step\s*\{[^}]*background:\s*var\(--rr-surface\)/s);
  assert.match(styles, /\.knowledge-step\.completed\s*\{[^}]*background:\s*var\(--rr-success-surface\)/s);
  assert.match(styles, /\.knowledge-plan-current\.blocked \.knowledge-plan-current-heading > :is\(span, small\)\s*\{[^}]*color:\s*var\(--rr-error-text\)/s);
  assert.match(styles, /\.knowledge-step-index\s*\{[^}]*background:\s*var\(--rr-accent-surface\)[^}]*color:\s*var\(--rr-accent-text\)/s);
  assert.doesNotMatch(styles, /\.knowledge-step-index\s*\{[^}]*background:\s*var\(--rr-heading\)/s);
  assert.match(styles, /html\[data-rabiroute-theme\] \.text-grey\s*\{[^}]*var\(--rr-muted\)/s);
  for (const [utility, token] of [["secondary", "accent"], ["success", "success"], ["warning", "warning"], ["error", "error"], ["info", "info"]] as const) {
    assert.match(styles, new RegExp(`html\\[data-rabiroute-theme\\] \\.text-${utility}\\s*\\{[^}]*var\\(--rr-${token}-text\\)`, "s"));
  }
});

test("theme-sensitive surfaces do not keep light-only background literals", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const lightOnlyBackground = /(?:^|;)\s*background(?:-color)?:[^;]*(?:#(?:fff(?:fff)?|f8fafc|e9eef2)\b|rgba?\(\s*(?:23[0-9]|24[0-9]|25[0-5])\s*,\s*(?:23[0-9]|24[0-9]|25[0-5])\s*,\s*(?:23[0-9]|24[0-9]|25[0-5])\s*(?:,|\)))/i;
  const offenders = cssRules(styles).filter(rule =>
    ![".napcat-login-qr", ".knowledge-plan-media-preview-stage"].some(selector => rule.selector.includes(selector))
    && lightOnlyBackground.test(rule.body)
  );

  assert.deepEqual(
    offenders.map(rule => rule.selector),
    [],
    "theme-sensitive surfaces must use shared surface tokens; the QR code keeps its required white substrate"
  );
});

test("placeholder text keeps full opacity", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const placeholderRules = cssRules(styles).filter(rule => rule.selector.includes("::placeholder"));

  assert.ok(placeholderRules.length > 0, "styles.css must own placeholder presentation");
  assert.ok(
    placeholderRules.some(rule => /(?:^|;)\s*opacity:\s*1\s*(?:!important\s*)?(?:;|$)/.test(rule.body)),
    "placeholder text must not inherit browser or Vuetify fading"
  );
});

test("Vuetify labels and subtitles keep full opacity", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const rules = cssRules(styles);

  for (const className of ["v-label", "v-card-subtitle", "v-list-item-subtitle"]) {
    const matchingRules = rulesForClass(rules, className);
    assert.ok(matchingRules.length > 0, `styles.css must own .${className} presentation`);
    assert.ok(
      matchingRules.some(rule => /(?:^|;)\s*opacity:\s*1\s*(?:!important\s*)?(?:;|$)/.test(rule.body)),
      `.${className} must not fade readable text`
    );
  }
});

test("performance slow-request metadata uses readable secondary text", () => {
  const source = fs.readFileSync(path.join(root, "src", "pages", "PerformancePage.vue"), "utf8");
  assert.match(source, /\.performance-slow-list span\s*\{[^}]*color:\s*var\(--rr-muted\)/s);
  assert.doesNotMatch(source, /\.performance-slow-list span\s*\{[^}]*color:\s*var\(--rr-muted-faint\)/s);
});

test("theme-related component styles stay outside Vue templates", () => {
  for (const relativePath of [
    path.join("src", "components", "LocaleSwitcher.vue"),
    path.join("src", "components", "QuickSetupDialog.vue")
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const styleIndex = source.indexOf("<style");
    const templateEnd = source.lastIndexOf("</template>");
    assert.ok(styleIndex > templateEnd, `${relativePath} must keep its style block outside the template`);
  }
});

test("Vuetify text-field affixes use readable theme text", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const rules = cssRules(styles);

  for (const className of ["v-text-field__prefix__text", "v-text-field__suffix__text"]) {
    const matchingRules = rulesForClass(rules, className);
    assert.ok(matchingRules.length > 0, `styles.css must own .${className} presentation`);
    assert.ok(
      matchingRules.some(rule => /(?:^|;)\s*color:\s*var\(--rr-muted\)\s*!important\s*(?:;|$)/.test(rule.body)),
      `.${className} must use the readable muted token`
    );
    assert.ok(
      matchingRules.some(rule => /(?:^|;)\s*opacity:\s*1\s*!important\s*(?:;|$)/.test(rule.body)),
      `.${className} must not use Vuetify's faded foreground`
    );
  }
});

test("accent strong is not used directly as a text foreground", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const offenders = cssRules(styles).filter(rule =>
    /(?:^|;)\s*color:\s*var\(--rr-accent-strong\)\s*(?:!important\s*)?(?:;|$)/.test(rule.body)
  );

  assert.deepEqual(
    offenders.map(rule => rule.selector),
    [],
    "--rr-accent-strong may style backgrounds and borders, but text must use a readable foreground token"
  );
});

test("plan directory filter count uses the paired accent foreground", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const rule = cssRules(styles).find(candidate => candidate.selector === ".knowledge-plan-directory-filter-count");

  assert.ok(rule, "plan directory filter count rule must remain present");
  assert.match(rule.body, /(?:^|;)\s*background:\s*var\(--rr-accent-strong\)(?:;|$)/);
  assert.match(rule.body, /(?:^|;)\s*color:\s*var\(--rr-on-accent-strong\)(?:;|$)/);
});

test("attachment text overlay uses one sufficiently opaque dark surface", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const rule = cssRules(styles).find(candidate => candidate.selector === ".knowledge-plan-attachment-overlay");

  assert.ok(rule, "attachment overlay rule must remain present");
  assert.doesNotMatch(rule.body, /linear-gradient/i, "text overlay must not cross backgrounds with different opacity");
  const background = rule.body.match(
    /(?:^|;)\s*background(?:-color)?:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0?\.\d+|1(?:\.0+)?)\s*\)(?:;|$)/
  );
  assert.ok(background, "attachment overlay must use one explicit rgba dark background");
  const channels = background.slice(1, 4).map(Number);
  const alpha = Number(background[4]);
  assert.ok(Math.max(...channels) <= 72, `attachment overlay background must stay dark: ${channels.join(", ")}`);
  assert.ok(alpha >= .8, `attachment overlay background opacity must be at least 0.8: ${alpha}`);
});

test("plan status text does not use a fixed color mix", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const offenders = rulesForClass(cssRules(styles), "knowledge-plan-status").filter(rule =>
    /(?:^|;)\s*color:\s*color-mix\(/.test(rule.body)
  );

  assert.deepEqual(
    offenders.map(rule => rule.selector),
    [],
    "plan status text must use its paired readable foreground instead of a fixed color-mix ratio"
  );
});

test("theme-sensitive controls keep readable colors without fading whole cards", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const topologyStart = styles.indexOf(".channel-topology {");
  const topologyEnd = styles.indexOf(".dependency-actions {", topologyStart);
  assert.ok(topologyStart >= 0 && topologyEnd > topologyStart, "Route topology styles must remain discoverable");
  const topologyStyles = styles.slice(topologyStart, topologyEnd);

  assert.doesNotMatch(topologyStyles, /--v-theme-secondary/, "Route topology must use RabiRoute semantic theme tokens");

  for (const selector of ["automation-card", "napcat-account-card"]) {
    const rule = styles.match(new RegExp(String.raw`\.${selector}\.disabled\s*\{([^}]*)\}`, "s"));
    assert.ok(rule, `${selector}.disabled rule must remain present`);
    assert.doesNotMatch(rule[1]!, /\bopacity\s*:/, `${selector}.disabled must not fade the whole card`);
  }

  assert.match(
    styles,
    /html\[data-rabiroute-theme="light"\] \.vad-meter \.bg-warning\s*\{[^}]*background-color:\s*var\(--rr-warning-text\)\s*!important/s
  );
});

test("theme-sensitive tabs and deferred knowledge states use shared surface tokens", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const persona = fs.readFileSync(path.join(root, "src", "pages", "PersonaTemplatePage.vue"), "utf8");

  assert.match(persona, /\.persona-page-tabs\s*\{[^}]*background:\s*var\(--rr-subtle\)/s);
  assert.match(styles, /\.automation-tabs\s*\{[^}]*background:\s*var\(--rr-subtle\)/s);
  assert.match(styles, /\.knowledge-plan-detail-pending\s*\{[^}]*background:\s*var\(--rr-subtle\)/s);
  assert.match(styles, /\.knowledge-load-more\s*\{[^}]*background:\s*var\(--rr-accent-surface\)/s);
  for (const selector of [
    "persona-page-tabs",
    "automation-editor-head",
    "identity-workspace-record",
    "knowledge-plan-agent-session-state",
    "knowledge-plan-attachment-file-icon"
  ]) {
    assert.match(styles, new RegExp(`html\\[data-rabiroute-theme="dark"\\][\\s\\S]*\\.${selector}`));
  }
});


test("dark identity cards and disabled controls keep readable theme colors", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const personaSync = fs.readFileSync(path.join(root, "src", "components", "PersonaSyncCard.vue"), "utf8");
  const performance = fs.readFileSync(path.join(root, "src", "pages", "PerformancePage.vue"), "utf8");

  assert.match(styles, /html\[data-rabiroute-theme="dark"\] :is\([\s\S]*\.identity-habit-card/);
  assert.match(styles, /html\[data-rabiroute-theme\] :is\([\s\S]*\.v-selection-control--disabled,[\s\S]*opacity:\s*1\s*!important/);
  const disabledMutedRule = [...styles.matchAll(/html\[data-rabiroute-theme\] :is\(([\s\S]*?)\)\s*\{([^}]*)\}/g)]
    .find(([, , body]) => /color:\s*var\(--rr-muted\)/.test(body));
  assert.ok(disabledMutedRule);
  assert.doesNotMatch(disabledMutedRule[1]!, /\.v-btn--disabled/, "disabled buttons must keep the foreground paired with their Vuetify background");
  const disabledButtonColorOverrides = rulesForClass(cssRules(styles), "v-btn--disabled")
    .filter(rule => /(?:^|;)\s*color\s*:/.test(rule.body));
  assert.deepEqual(
    disabledButtonColorOverrides.map(rule => rule.selector),
    [],
    "disabled buttons must keep the foreground supplied by their Vuetify background"
  );
  assert.match(styles, /\.knowledge-plan-list-filter-options label\.disabled\s*\{[^}]*color:\s*var\(--rr-muted\)[^}]*opacity:\s*1/s);
  assert.match(styles, /:is\([\s\S]*\.v-field-label,[\s\S]*\.v-messages,[\s\S]*\.v-messages__message[\s\S]*\)\s*\{[^}]*color:\s*var\(--rr-muted\)[^}]*opacity:\s*1/s);
  assert.doesNotMatch(personaSync, /\.sync-peer-choice\.disabled\s*\{[^}]*opacity:\s*\.(?:[0-9]+)/s);
  assert.match(personaSync, /\.sync-peer-choice\.disabled\s*\{[^}]*background:\s*var\(--rr-subtle\)[^}]*opacity:\s*1/s);
  assert.match(performance, /\.performance-kicker\s*\{\s*color:\s*#b8f5f3/);
});

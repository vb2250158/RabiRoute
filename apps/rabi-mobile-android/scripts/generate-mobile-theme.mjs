import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../..');

export function readThemeTokens(css) {
  const tokens = Object.fromEntries([...css.matchAll(/--rr-([a-z-]+):\s*(#[\da-f]{6});/gi)].map(([, key, value]) => [key, value.toLowerCase()]));
  for (const key of ['canvas', 'surface', 'text', 'heading', 'muted', 'border', 'accent-strong', 'input']) {
    if (!tokens[key]) throw new Error(`Missing WebGUI theme token: ${key}`);
  }
  return tokens;
}

export function generateMobileThemes(output = path.join(project, 'app/build/generated/mobileTheme')) {
  const palettes = Object.fromEntries(['light', 'dark'].map(mode => [mode,
    readThemeTokens(fs.readFileSync(path.join(root, `ribiwebgui/src/themes/${mode}/tokens.css`), 'utf8'))]));
  const sourceDir = path.join(output, 'java/com/rabi/link');
  const valuesDir = path.join(output, 'res/values');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'RabiThemeTokens.kt'),
    '// Generated from WebGUI tokens.css. Do not edit.\npackage com.rabi.link\n\ninternal object RabiThemeTokens {\n' +
    Object.entries(palettes).map(([mode, tokens]) => `    val ${mode} = mapOf(\n${Object.entries(tokens).map(([key, value]) => `        "${key}" to 0xff${value.slice(1)}.toInt()`).join(',\n')}\n    )`).join('\n') + '\n}\n');
  const styles = Object.entries(palettes).map(([mode, t]) => {
    const dark = mode === 'dark';
    return `<style name="Rabi${dark ? 'Dark' : 'Light'}" parent="android:style/Theme.Material.${dark ? '' : 'Light.'}NoActionBar">
    <item name="android:fontFamily">sans-serif</item>
    <item name="android:windowActionModeOverlay">true</item>
    <item name="android:windowBackground">${t.canvas}</item>
    <item name="android:colorBackground">${t.canvas}</item>
    <item name="android:colorBackgroundFloating">${t.surface}</item>
    <item name="android:statusBarColor">${t.canvas}</item>
    <item name="android:navigationBarColor">${t.surface}</item>
    <item name="android:windowLightStatusBar">${!dark}</item>
    <item name="android:windowLightNavigationBar">${!dark}</item>
    <item name="android:colorAccent">${t['accent-strong']}</item>
    <item name="android:colorControlActivated">${t['accent-strong']}</item>
    <item name="android:colorButtonNormal">${t.subtle}</item>
    <item name="android:textColorPrimary">${t.text}</item>
    <item name="android:textColorSecondary">${t.muted}</item>
    <item name="android:forceDarkAllowed">false</item>
  </style>`;
  });
  fs.writeFileSync(path.join(valuesDir, 'mobile_themes.xml'), `<!-- Generated from WebGUI tokens.css. -->\n<resources>\n${styles.join('\n')}\n</resources>\n`);
  return palettes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateMobileThemes();

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMobileThemes, readThemeTokens } from './generate-mobile-theme.mjs';

function luminance(hex) {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('generated Android palettes retain WebGUI tokens and readable text in both skins', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-mobile-theme-'));
  try {
    const themes = generateMobileThemes(directory);
    const kotlin = fs.readFileSync(path.join(directory, 'java/com/rabi/link/RabiThemeTokens.kt'), 'utf8');
    const xml = fs.readFileSync(path.join(directory, 'res/values/mobile_themes.xml'), 'utf8');
    for (const [mode, tokens] of Object.entries(themes)) {
      for (const [token, value] of Object.entries(tokens)) assert.ok(kotlin.includes(`"${token}" to 0xff${value.slice(1)}.toInt()`));
      for (const background of ['canvas', 'surface', 'input']) {
        for (const foreground of ['text', 'heading', 'muted']) {
          assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${mode}: ${foreground} on ${background}`);
        }
      }
      assert.ok(contrast(tokens['on-accent-strong'], tokens['accent-strong']) >= 4.5, `${mode}: button/chat foreground`);
      for (const tone of ['success', 'warning', 'error']) assert.ok(contrast(tokens[`${tone}-text`], tokens[`${tone}-surface`]) >= 4.5, `${mode}: ${tone}`);
    }
    assert.ok(xml.includes('Theme.Material.Light.NoActionBar'));
    assert.ok(xml.includes('Theme.Material.NoActionBar'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing upstream tokens fail the build instead of shipping an incomplete skin', () => {
  assert.throws(() => readThemeTokens('--rr-text: #112033;'), /Missing WebGUI theme token/);
});

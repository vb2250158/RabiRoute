import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { englishCatalog, englishPatterns } from "../src/i18n/catalog";
import { japaneseCatalog, japanesePatterns } from "../src/i18n/japanese";
import { LOCALE_STORAGE_KEY, resolveLocale, setLocale, translateText, useI18n } from "../src/i18n";
import { guideKey, guideLocale, guideSection } from "../src/docs/guideLocale";
import { formatSpeechEpochSeconds } from "../src/speech/speechRecordPresentation";

test("Japanese locale detection respects the saved browser preference", () => {
  assert.equal(resolveLocale(null, "ja-JP"), "ja");
  assert.equal(resolveLocale(null, "JA"), "ja");
  assert.equal(resolveLocale("ja", "en-US"), "ja");
  assert.equal(resolveLocale("en", "ja-JP"), "en");
  assert.equal(resolveLocale("zh-CN", "ja-JP"), "zh-CN");
  assert.equal(resolveLocale("invalid", "zh-TW"), "zh-CN");
  assert.equal(resolveLocale(null, "fr-FR"), "en");
});

test("Japanese catalog covers the existing interface and dynamic templates", () => {
  for (const key of Object.keys(englishCatalog)) assert.ok(japaneseCatalog[key], key);
  for (const [key, value] of Object.entries(japaneseCatalog)) {
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /ZXQ\s*\d|QXZ|\[\d{5}\]/i, key);
  }
  for (const [pattern] of englishPatterns) {
    assert.ok(japanesePatterns.some(([candidate]) => candidate.source === pattern.source), pattern.source);
  }
  assert.equal(translateText("  保存配置  ", "ja"), "  設定を保存  ");
  assert.equal(translateText("设置", "ja"), "設定");
  assert.equal(translateText("计划审批", "ja"), "計画の承認");
  assert.equal(translateText("8 条模板", "ja"), "8 件のテンプレート");
  assert.equal(translateText("每 10 秒一个图表点", "ja"), "10 秒ごとにグラフを記録");
});

test("Japanese display preserves configured identifiers, paths and regular expressions", () => {
  assert.equal(translateText("main · NapCat / OneBot + 定时触发", "ja"), "main · NapCat / OneBot + 定期実行");
  assert.equal(translateText("运行 tools/check.cmd", "ja"), "tools/check.cmd を実行");
  assert.equal(translateText("群聊-普通消息 · 匹配：Rabi|RabiRoute|看板娘", "ja"), "グループ：通常のメッセージ · 一致条件：Rabi|RabiRoute|看板娘");
  assert.equal(translateText("角色 ID · ExampleRole", "ja"), "ペルソナ ID · ExampleRole");
  assert.equal(translateText("QQ 消息监听", "ja"), "QQ 消息监听");
  assert.equal(translateText("设置", "zh-CN"), "设置");
  assert.equal(translateText("设置", "en"), "Settings");
  assert.equal(translateText("http://localhost/callback · 未响应", "ja"), "http://localhost/callback · 応答なし");
});

test("changing language and refreshing retain the Japanese preference", () => {
  const stored = new Map<string, string>();
  const events: Event[] = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousCustomEvent = globalThis.CustomEvent;
  Object.assign(globalThis, {
    window: { localStorage: { setItem: (key: string, value: string) => stored.set(key, value) }, dispatchEvent: (event: Event) => events.push(event) },
    document: { documentElement: { lang: "zh-CN" } },
    CustomEvent: class extends Event { detail: unknown; constructor(type: string, options: { detail: unknown }) { super(type); this.detail = options.detail; } }
  });
  try {
    setLocale("ja");
    assert.equal(useI18n().locale.value, "ja");
    assert.equal(document.documentElement.lang, "ja");
    assert.equal(resolveLocale(stored.get(LOCALE_STORAGE_KEY) || null, "en-US"), "ja");
    assert.equal(translateText("设置"), "設定");
    setLocale("en");
    assert.equal(translateText("设置"), "Settings");
    setLocale("zh-CN");
    assert.equal(translateText("设置"), "设置");
    assert.equal(events.length, 3);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, CustomEvent: previousCustomEvent });
  }
});

test("Japanese user guides have matching keys, sections and unchanged code examples", () => {
  const directory = new URL("../../docs/user-guide/", import.meta.url);
  const files = fs.readdirSync(directory);
  for (const filename of files.filter(name => name.endsWith("_en.md"))) {
    const japaneseFile = filename.replace(/_en\.md$/, "_ja.md");
    assert.ok(files.includes(japaneseFile), japaneseFile);
    assert.equal(guideKey(japaneseFile), guideKey(filename));
    assert.equal(guideLocale(japaneseFile), "ja");
    const english = fs.readFileSync(new URL(filename, directory), "utf8").replace(/\r\n/g, "\n");
    const japanese = fs.readFileSync(new URL(japaneseFile, directory), "utf8").replace(/\r\n/g, "\n");
    assert.deepEqual(japanese.match(/```[\s\S]*?```/g), english.match(/```[\s\S]*?```/g), filename);
    assert.deepEqual(japanese.match(/`[^`\n]+`/g), english.match(/`[^`\n]+`/g), `${filename}: inline code`);
    assert.equal([...japanese.matchAll(/\]\([^)]+\)/g)].length, [...english.matchAll(/\]\([^)]+\)/g)].length, `${filename}: links and images`);
    assert.doesNotMatch(japanese, /ZXQ\s*\d|QXZ|\[\d{5}\]/i, filename);
    for (const match of japanese.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(match[1])) continue;
      assert.ok(fs.existsSync(new URL(match[1].split("#")[0], new URL(japaneseFile, directory))), `${japaneseFile}: ${match[1]}`);
    }
  }
  assert.equal(guideSection("first-route", "ja"), "はじめに");
  assert.equal(guideSection("safety-and-data", "ja"), "運用と安全");
  assert.equal(guideLocale("first-route.md"), "zh-CN");
  assert.equal(guideLocale("first-route_en.md"), "en");
  assert.equal(formatSpeechEpochSeconds(1_700_000_000, "ja"), new Date(1_700_000_000_000).toLocaleString("ja", { hour12: false }));
});

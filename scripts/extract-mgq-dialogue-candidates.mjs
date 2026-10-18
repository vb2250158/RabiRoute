import fs from "node:fs";
import path from "node:path";

const [inputPath, outDir] = process.argv.slice(2);
if (!inputPath || !outDir) {
  console.error("Usage: node scripts/extract-mgq-dialogue-candidates.mjs <translation.json> <output-directory>");
  process.exit(1);
}

const text = fs.readFileSync(inputPath, "utf8");
const dictionary = JSON.parse(text);
fs.mkdirSync(outDir, { recursive: true });

const entries = Object.entries(dictionary).map(([jp, zh], index) => ({
  index,
  jp,
  zh: String(zh ?? ""),
}));

const aliceLabel = /【(?:アリス|爱丽丝|愛麗絲)】/;
const iliasLabel = /【(?:イリアス|伊莉娅丝|伊莉娅斯|伊莉亞絲|伊莉亞斯)】/;

const aliceMention = /(?:アリス|爱丽丝|愛麗絲)/;
const iliasMention = /(?:イリアス|伊莉娅丝|伊莉娅斯|伊莉亞絲|伊莉亞斯)/;

const aliceVariantNoise =
  /(?:アリストロメリア|爱丽丝托梅莉娅|愛麗絲托梅莉婭|アリスフィーズ|爱丽丝菲兹|愛麗絲菲茲|黒のアリス|黑之爱丽丝|白兎のアリス|白兔爱丽丝|ルイス・キャロル)/;

function hasAliceLabel(entry) {
  return aliceLabel.test(entry.jp) || aliceLabel.test(entry.zh);
}

function hasIliasLabel(entry) {
  return iliasLabel.test(entry.jp) || iliasLabel.test(entry.zh);
}

function hasAliceMention(entry) {
  if (aliceVariantNoise.test(entry.jp) || aliceVariantNoise.test(entry.zh)) {
    return false;
  }
  return aliceMention.test(entry.jp) || aliceMention.test(entry.zh);
}

function hasIliasMention(entry) {
  return iliasMention.test(entry.jp) || iliasMention.test(entry.zh);
}

function isAnySpeakerLabel(entry) {
  return /【[^】]{1,24}】/.test(entry.jp) || /【[^】]{1,24}】/.test(entry.zh);
}

function writeJsonl(fileName, rows) {
  const filePath = path.join(outDir, fileName);
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.writeFileSync(filePath, body ? `${body}\n` : "", "utf8");
  return filePath;
}

function buildDialogueWindows(labelName, matchesLabel) {
  const windows = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!matchesLabel(entry)) continue;

    const lines = [];
    for (let j = i + 1; j < entries.length && lines.length < 12; j += 1) {
      const next = entries[j];
      if (isAnySpeakerLabel(next)) break;
      if (!next.jp && !next.zh) continue;
      lines.push(next);
    }

    windows.push({
      speaker: labelName,
      label: entry,
      lines,
    });
  }
  return windows;
}

const aliceLabels = entries.filter(hasAliceLabel);
const iliasLabels = entries.filter(hasIliasLabel);
const bothMentions = entries.filter(
  (entry) => hasAliceMention(entry) && hasIliasMention(entry),
);
const aliceMentions = entries.filter(hasAliceMention);
const iliasMentions = entries.filter(hasIliasMention);
const aliceWindows = buildDialogueWindows("alice", hasAliceLabel);
const iliasWindows = buildDialogueWindows("ilias", hasIliasLabel);

const files = {
  aliceLabels: writeJsonl("alice-speaker-labels.jsonl", aliceLabels),
  iliasLabels: writeJsonl("ilias-speaker-labels.jsonl", iliasLabels),
  aliceWindows: writeJsonl("alice-dialogue-windows.jsonl", aliceWindows),
  iliasWindows: writeJsonl("ilias-dialogue-windows.jsonl", iliasWindows),
  bothMentions: writeJsonl("alice-ilias-both-mentions.jsonl", bothMentions),
  aliceMentions: writeJsonl("alice-name-mentions.jsonl", aliceMentions),
  iliasMentions: writeJsonl("ilias-name-mentions.jsonl", iliasMentions),
};

const summary = {
  inputPath,
  outDir,
  totalEntries: entries.length,
  counts: {
    aliceSpeakerLabels: aliceLabels.length,
    iliasSpeakerLabels: iliasLabels.length,
    aliceDialogueWindows: aliceWindows.length,
    iliasDialogueWindows: iliasWindows.length,
    bothNameMentions: bothMentions.length,
    aliceNameMentions: aliceMentions.length,
    iliasNameMentions: iliasMentions.length,
  },
  notes: [
    "翻译.json 是 MTool 翻译词典，不保证每一项都有地图、事件、说话人归属。",
    "speaker-labels 和 dialogue-windows 是较可信候选：依赖【アリス】/【イリアス】这类标签及其后续条目。",
    "name-mentions 只是相关片段索引，不能直接视作对应角色台词。",
    "要做精确全量归属，需要从 Game.rgss3a 解出 RPGMaker VxAce Data，再按事件命令顺序关联说话人标签和文本。",
  ],
  files,
};

const summaryPath = path.join(outDir, "summary.json");
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

console.log(JSON.stringify(summary, null, 2));

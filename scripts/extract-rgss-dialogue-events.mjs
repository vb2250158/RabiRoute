import fs from "node:fs";
import path from "node:path";

const [dataDir, translationPath, outDir] = process.argv.slice(2);
if (!dataDir || !translationPath || !outDir) {
  console.error("Usage: node scripts/extract-rgss-dialogue-events.mjs <Data-directory> <translation.json> <output-directory>");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const translations = JSON.parse(fs.readFileSync(translationPath, "utf8"));

class MarshalReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
    this.symbols = [];
    this.objects = [];
  }

  byte() {
    if (this.offset >= this.buffer.length) {
      throw new Error("Unexpected end of marshal stream");
    }
    return this.buffer[this.offset++];
  }

  signedByte() {
    const value = this.byte();
    return value > 127 ? value - 256 : value;
  }

  bytes(length) {
    const start = this.offset;
    this.offset += length;
    if (this.offset > this.buffer.length) {
      throw new Error("Unexpected end of marshal stream");
    }
    return this.buffer.subarray(start, this.offset);
  }

  long() {
    const first = this.signedByte();
    if (first === 0) return 0;
    if (first > 4) return first - 5;
    if (first < -4) return first + 5;

    const length = Math.abs(first);
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value |= this.byte() << (8 * i);
    }
    if (first < 0) {
      for (let i = length; i < 4; i += 1) {
        value |= 0xff << (8 * i);
      }
    }
    return value;
  }

  stringBytes() {
    return this.bytes(this.long());
  }

  decode(bytes) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  read() {
    const type = String.fromCharCode(this.byte());
    switch (type) {
      case "0":
        return null;
      case "T":
        return true;
      case "F":
        return false;
      case "i":
        return this.long();
      case ":":
        return this.readSymbol();
      case ";":
        return this.symbols[this.long()];
      case '"':
        return this.readString();
      case "I":
        return this.readWithInstanceVariables();
      case "[":
        return this.readArray();
      case "{":
        return this.readHash(false);
      case "}":
        return this.readHash(true);
      case "o":
        return this.readObject();
      case "@":
        return this.objects[this.long()];
      case "f":
        return Number(this.decode(this.stringBytes()));
      case "/":
        return new RegExp(this.decode(this.stringBytes()));
      case "l":
        return this.readBignum();
      case "C":
      case "U":
        return this.readWrappedObject(type);
      case "u":
        return this.readUserDefined();
      case "S":
        return this.readStruct();
      case "c":
      case "m":
      case "M":
        return { __classRef: this.decode(this.stringBytes()), __type: type };
      default:
        throw new Error(`Unsupported marshal type ${JSON.stringify(type)} at ${this.offset - 1}`);
    }
  }

  readSymbol() {
    const symbol = this.decode(this.stringBytes());
    this.symbols.push(symbol);
    return symbol;
  }

  readString() {
    const value = this.decode(this.stringBytes());
    this.objects.push(value);
    return value;
  }

  readWithInstanceVariables() {
    const value = this.read();
    const count = this.long();
    const ivars = {};
    for (let i = 0; i < count; i += 1) {
      const key = this.read();
      ivars[key] = this.read();
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value.__ivars = { ...(value.__ivars ?? {}), ...ivars };
    }
    return value;
  }

  readArray() {
    const length = this.long();
    const array = [];
    this.objects.push(array);
    for (let i = 0; i < length; i += 1) {
      array.push(this.read());
    }
    return array;
  }

  readHash(hasDefault) {
    const count = this.long();
    const hash = {};
    this.objects.push(hash);
    for (let i = 0; i < count; i += 1) {
      hash[String(this.read())] = this.read();
    }
    if (hasDefault) hash.__default = this.read();
    return hash;
  }

  readObject() {
    const className = this.read();
    const obj = { __class: className };
    this.objects.push(obj);
    const count = this.long();
    for (let i = 0; i < count; i += 1) {
      obj[this.read()] = this.read();
    }
    return obj;
  }

  readBignum() {
    const sign = String.fromCharCode(this.byte()) === "+" ? 1n : -1n;
    const words = this.long();
    let value = 0n;
    for (let i = 0; i < words; i += 1) {
      value += BigInt(this.byte() | (this.byte() << 8)) << BigInt(16 * i);
    }
    const signed = sign * value;
    return Number.isSafeInteger(Number(signed)) ? Number(signed) : signed.toString();
  }

  readWrappedObject(type) {
    const className = this.read();
    const value = this.read();
    if (value && typeof value === "object") value.__wrappedClass = className;
    return value;
  }

  readUserDefined() {
    const className = this.read();
    const raw = this.bytes(this.long());
    const value = { __class: className, __userDefinedBytes: raw.length };
    this.objects.push(value);
    return value;
  }

  readStruct() {
    const className = this.read();
    const obj = { __class: className, __struct: true };
    this.objects.push(obj);
    const count = this.long();
    for (let i = 0; i < count; i += 1) {
      obj[this.read()] = this.read();
    }
    return obj;
  }
}

function loadRvdata2(filePath) {
  const buffer = fs.readFileSync(filePath);
  const reader = new MarshalReader(buffer);
  const major = reader.byte();
  const minor = reader.byte();
  if (major !== 4 || minor !== 8) {
    throw new Error(`${filePath} is not Ruby Marshal 4.8`);
  }
  return reader.read();
}

function walkFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".rvdata2")) result.push(full);
  }
  return result;
}

function isEventCommand(value) {
  return value && typeof value === "object" && value.__class === "RPG::EventCommand";
}

function commandCode(command) {
  return command["@code"] ?? command.code;
}

function commandParameters(command) {
  return command["@parameters"] ?? command.parameters ?? [];
}

function collectCommandLists(value, lists, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.some(isEventCommand)) {
      lists.push(value.filter(isEventCommand));
    }
    for (const item of value) collectCommandLists(item, lists, seen);
    return;
  }

  for (const item of Object.values(value)) {
    collectCommandLists(item, lists, seen);
  }
}

const speakerPatterns = [
  { speaker: "alice", re: /^【(?:アリス|爱丽丝|愛麗絲)】$/ },
  { speaker: "ilias", re: /^【(?:イリアス|伊莉娅丝|伊莉娅斯|伊莉亞絲|伊莉亞斯)】$/ },
];

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function translated(text) {
  return translations[text] ?? "";
}

function speakerFromLine(text) {
  const zh = translated(text);
  for (const { speaker, re } of speakerPatterns) {
    if (re.test(text) || re.test(zh)) return speaker;
  }
  return null;
}

function mentionsTarget(text) {
  const zh = translated(text);
  return /アリス|爱丽丝|愛麗絲|イリアス|伊莉娅丝|伊莉娅斯|伊莉亞絲|伊莉亞斯/.test(
    `${text}\n${zh}`,
  );
}

function extractTextFromCommand(command) {
  const code = commandCode(command);
  if (code !== 401 && code !== 405) return null;
  const params = commandParameters(command);
  if (!Array.isArray(params) || typeof params[0] !== "string") return null;
  return normalizeText(params[0]);
}

function writeJsonl(fileName, rows) {
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    "utf8",
  );
  return filePath;
}

const files = walkFiles(dataDir);
const dialogueRows = [];
const mentionRows = [];
const errors = [];

for (const filePath of files) {
  let root;
  try {
    root = loadRvdata2(filePath);
  } catch (error) {
    errors.push({ filePath, error: error.message });
    continue;
  }

  const lists = [];
  collectCommandLists(root, lists);
  const source = path.relative(dataDir, filePath).replaceAll("\\", "/");

  lists.forEach((commands, listIndex) => {
    let currentSpeaker = null;
    let lineAfterLabel = 0;

    commands.forEach((command, commandIndex) => {
      const text = extractTextFromCommand(command);
      if (!text) return;

      const nextSpeaker = speakerFromLine(text);
      if (nextSpeaker) {
        currentSpeaker = nextSpeaker;
        lineAfterLabel = 0;
        return;
      }

      const row = {
        source,
        listIndex,
        commandIndex,
        speaker: currentSpeaker,
        text,
        zh: translated(text),
      };

      if ((currentSpeaker === "alice" || currentSpeaker === "ilias") && lineAfterLabel < 80) {
        dialogueRows.push(row);
        lineAfterLabel += 1;
      }

      if (mentionsTarget(text)) {
        mentionRows.push(row);
      }
    });
  });
}

const aliceRows = dialogueRows.filter((row) => row.speaker === "alice");
const iliasRows = dialogueRows.filter((row) => row.speaker === "ilias");

const outputFiles = {
  allSpeakerAttributed: writeJsonl("speaker-attributed-dialogue.jsonl", dialogueRows),
  aliceAttributed: writeJsonl("alice-attributed-dialogue.jsonl", aliceRows),
  iliasAttributed: writeJsonl("ilias-attributed-dialogue.jsonl", iliasRows),
  nameMentionsInEvents: writeJsonl("name-mentions-in-events.jsonl", mentionRows),
  parseErrors: writeJsonl("parse-errors.jsonl", errors),
};

const summary = {
  dataDir,
  translationPath,
  outDir,
  scannedFiles: files.length,
  parseErrors: errors.length,
  counts: {
    speakerAttributedDialogue: dialogueRows.length,
    aliceAttributedDialogue: aliceRows.length,
    iliasAttributedDialogue: iliasRows.length,
    nameMentionsInEvents: mentionRows.length,
  },
  notes: [
    "speaker-attributed-dialogue 依赖事件命令顺序中的说话人标签，可信度高于翻译词典平铺搜索。",
    "如果原事件没有显式说话人标签，name-mentions-in-events 只代表相关上下文，不代表该角色发言。",
    "输出文件包含游戏文本，仅用于本机索引；对外总结时不要整段复制。",
  ],
  files: outputFiles,
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));

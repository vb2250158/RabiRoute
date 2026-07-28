import assert from "node:assert/strict";
import test from "node:test";
import { copyTextToClipboard } from "../src/clipboard";

function fallbackDocument(result = true): {
  document: Document;
  state: { appended: number; removed: number; selected: number; command: string };
} {
  const state = { appended: 0, removed: 0, selected: 0, command: "" };
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    focus() {},
    select() { state.selected += 1; },
    setSelectionRange() {}
  };
  const document = {
    body: {
      appendChild() { state.appended += 1; },
      removeChild() { state.removed += 1; }
    },
    createElement() { return textarea; },
    execCommand(command: string) {
      state.command = command;
      return result;
    }
  } as unknown as Document;
  return { document, state };
}

test("uses the Clipboard API when it is available", async () => {
  const writes: string[] = [];
  await copyTextToClipboard("LAN link", {
    clipboard: { async writeText(text) { writes.push(text); } },
    document: null
  });
  assert.deepEqual(writes, ["LAN link"]);
});

test("falls back to a hidden textarea on insecure HTTP pages", async () => {
  const fallback = fallbackDocument();
  await copyTextToClipboard("http://192.168.0.57:8790", {
    clipboard: null,
    document: fallback.document
  });
  assert.equal(fallback.state.command, "copy");
  assert.equal(fallback.state.selected, 1);
  assert.equal(fallback.state.appended, 1);
  assert.equal(fallback.state.removed, 1);
});

test("uses the fallback when Clipboard API permission is rejected", async () => {
  const fallback = fallbackDocument();
  await copyTextToClipboard("secret", {
    clipboard: { async writeText() { throw new Error("permission denied"); } },
    document: fallback.document
  });
  assert.equal(fallback.state.command, "copy");
});

test("returns a clear error when neither copy mechanism is available", async () => {
  await assert.rejects(
    copyTextToClipboard("text", { clipboard: null, document: null }),
    /手动选择文本复制/
  );
});

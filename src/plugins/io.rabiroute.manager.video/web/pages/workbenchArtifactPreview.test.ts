import assert from "node:assert/strict";
import test from "node:test";
import { primaryArtifact, previewFor, previewText, type PreviewArtifact } from "./workbenchArtifactPreview";

const artifact = (path: string): PreviewArtifact =>
  ({ id: "a1", name: path.split("/").at(-1) || path, path, href: `/api/video/v2/runs/r1/artifacts?artifact=a1` });
const resolve = (href: string) => `manager:${href}`;

test("the artifact extension picks the inline renderer", () => {
  // §2.2: the card body renders whatever the first artifact is, instead of
  // sending the user out to a new tab.
  assert.equal(previewFor(artifact("out/note.md"), resolve).mode, "text");
  assert.equal(previewFor(artifact("out/cover.png"), resolve).mode, "image");
  assert.equal(previewFor(artifact("out/clip.mp4"), resolve).mode, "video");
  assert.equal(previewFor(artifact("out/voice.wav"), resolve).mode, "audio");
});

test("a binary type with no renderer says so instead of showing a broken frame", () => {
  const preview = previewFor(artifact("out/pack.bin"), resolve);
  assert.equal(preview.mode, "none");
  assert.match((preview as { reason: string }).reason, /下载/);
});

test("every preview points at the run-scoped endpoint, never a local path", () => {
  // The browser cannot read local files, and the owner re-checks ownership and hash.
  for (const path of ["out/a.txt", "out/b.png", "out/c.mp4"]) {
    const preview = previewFor(artifact(path), resolve) as { url: string };
    assert.equal(preview.url, "manager:/api/video/v2/runs/r1/artifacts?artifact=a1");
  }
});

test("a card with no artifact asks for none rather than guessing a path", () => {
  const preview = previewFor(undefined, resolve);
  assert.equal(preview.mode, "none");
  assert.equal((preview as { reason: string }).reason, "还没有产物。");
});

test("text preview keeps the first lines and reports truncation", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const preview = previewText(source);
  assert.equal(preview.text.split("\n").length, 6);
  assert.equal(preview.truncated, true);
  assert.match(preview.text, /^line 1\n/);
});

test("short text is shown whole and not marked truncated", () => {
  const preview = previewText("one\ntwo");
  assert.equal(preview.text, "one\ntwo");
  assert.equal(preview.truncated, false);
});

test("windows line endings do not produce blank preview lines", () => {
  assert.equal(previewText("a\r\nb\r\nc").text, "a\nb\nc");
});

test("only the first artifact becomes the card body", () => {
  assert.equal(primaryArtifact([]), undefined);
  assert.equal(primaryArtifact([artifact("a.md"), artifact("b.png")])?.path, "a.md");
});

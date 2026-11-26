import assert from "node:assert/strict";
import test from "node:test";
import { artifactBadge, artifactKind, cardBadges, mergedInputs, artifactKindGlyphs } from "./workbenchCardView";
import type { FlowNode } from "./workbenchEditor";

const node = (extra: Partial<FlowNode> = {}): FlowNode => ({ id: "n", kind: "command", config: {}, ...extra });

test("the artifact extension picks the glyph and unknown files stay neutral", () => {
  assert.equal(artifactKind("reports/warnings.md"), "text");
  assert.equal(artifactKind("cover.PNG"), "image");
  assert.equal(artifactKind("clips/intro.mp4"), "video");
  assert.equal(artifactKind("voice/line.wav"), "audio");
  assert.equal(artifactKind("archive.bin"), "other");
  assert.equal(artifactKind(undefined), "other");
  assert.equal(artifactKind("no-extension"), "other");
  assert.deepEqual(artifactKindGlyphs, { text: "T", image: "◫", video: "▶", audio: "♪", other: "•" });
});

test("a badge counts every artifact but shows one glyph per distinct kind", () => {
  // §2.3: the corner shows a count and type icons, not one chip per file.
  const badge = artifactBadge([
    { path: "a.md" }, { path: "b.txt" }, { path: "c.mp4" },
  ]);
  assert.equal(badge.count, 3);
  assert.deepEqual(badge.kinds, ["text", "video"]);
  assert.deepEqual(badge.glyphs, ["T", "▶"]);
});

test("material links and text links from the same source merge into one row", () => {
  // §5.3: these used to be two separate chip rows, so one upstream node could
  // appear twice and neither row told the whole story.
  const rows = mergedInputs({
    material: [{ from: "sources", sourceTitle: "采集", artifactKeys: ["news.md", "raw.json"] }],
    text: [{ id: "sources", title: "采集" }, { id: "notes", title: "笔记" }],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { from: "sources", title: "采集", kind: "material",
    artifactKeys: ["news.md", "raw.json"], artifactKinds: ["text", "text"] });
  assert.deepEqual(rows[1], { from: "notes", title: "笔记", kind: "text", artifactKeys: [], artifactKinds: ["text"] });
});

test("a text-only upstream and a material-only upstream both appear exactly once", () => {
  const rows = mergedInputs({
    material: [{ from: "a", sourceTitle: "A", artifactKeys: ["x.png"] }],
    text: [{ id: "b", title: "B" }],
  });
  assert.deepEqual(rows.map(row => [row.from, row.kind]), [["a", "material"], ["b", "text"]]);
});

test("the same source connected twice keeps one row and deduplicates its keys", () => {
  const rows = mergedInputs({
    material: [
      { from: "a", sourceTitle: "A", artifactKeys: ["x.png"] },
      { from: "a", sourceTitle: "A", artifactKeys: ["x.png", "y.png"] },
    ],
    text: [],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.artifactKeys, ["x.png", "y.png"]);
  assert.deepEqual(rows[0]!.artifactKinds, ["image"]);
});

test("card corners read declared outputs and merged inputs together", () => {
  // A card that has not run yet still advertises what it will produce, because
  // the requirement is declared on the node rather than only on the receipt.
  const declared = node({ requirements: [{ key: "brief", freshness: "produced" }, { key: "list", freshness: "produced" }] });
  const badges = cardBadges(declared, [], mergedInputs({
    material: [{ from: "up", sourceTitle: "上游", artifactKeys: ["news.md"] }],
    text: [],
  }));
  assert.equal(badges.outputCount, 2);
  assert.deepEqual(badges.inputGlyphs, ["T"]);
  assert.equal(badges.inputCount, 1);
});

test("a card with no artifacts and no inputs shows zero on both corners", () => {
  const badges = cardBadges(node(), [], []);
  assert.deepEqual({ out: badges.outputCount, into: badges.inputCount, glyphs: badges.outputGlyphs }, { out: 0, into: 0, glyphs: [] });
});

test("produced artifacts win over declarations once the node has run", () => {
  const badges = cardBadges(node({ requirements: [{ key: "a", freshness: "produced" }] }), [{ path: "out.mp4" }], []);
  assert.equal(badges.outputCount, 1);
  assert.deepEqual(badges.outputGlyphs, ["▶"]);
});

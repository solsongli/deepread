// Regression tests: MinerU oversized boxes, caption mapping and translation styles.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const scope = { DeepRead: {}, console, setTimeout, clearTimeout, Intl };
vm.createContext(scope);
for (const name of ["services/typography", "pipeline/summaryManager", "pipeline/languages", "pipeline/pipeline", "reader/overlay"]) {
  vm.runInContext(fs.readFileSync(new URL(`../addon/content/scripts/${name}.js`, import.meta.url), "utf8"), scope);
}
const D = scope.DeepRead;
const plain = (x) => JSON.parse(JSON.stringify(x));
function chars(text, size = 10, boldUntil = 0, offset = 0, y = 700) {
  return [...text].map((u, i) => ({ u, fontSize: size, fontName: i < boldUntil ? "Times-Bold" : "Times-Roman",
    offset: offset + i, pageIndex: 0, rect: [40 + i * 4, y, 44 + i * 4, y + size], lineBreakAfter: i === text.length - 1 }));
}
const source = "Important result. Ordinary explanation.";
const cs = chars(source, 10, 17);
const sentence = { text: source, charMapping: cs.map((c) => c.offset) };
assert.equal(D.Typography.styledSentence(sentence, cs), "**Important result.** Ordinary explanation.");
assert.equal(D.Typography.styledSentence({ text: source }, cs), source);
assert.deepEqual(plain(D.Typography.metrics(cs)), { fontSize: 10 });
const surrounded = [...chars("Axis label", 20), ...cs, ...chars("Figure legend", 8)];
assert.equal(D.Typography.match(surrounded, source).map((c) => c.u).join(""), source);
assert.equal(D.Typography.match([...cs, ...cs], source), null, "ambiguous match must not guess");
assert.equal(D.Typography.match(cs, "OCR mismatch in source"), null);

const p = new D.Pipeline({ getPdfApp: () => null, llm: async () => ({ content: "" }), parsePDF: async () => ({}) });
p._convertMinerUBboxToPdfCoords = (r) => r;
p._summaryManager.setCharsDataList(cs);
assert.ok(p._buildPagePrompt([{ page_idx: 0, paragraph_idx: 0, sentences: [sentence] }]).includes("**Important result.** Ordinary explanation."));
const caption = "Figure 1: Measured performance.";
const capChars = chars(caption, 9, 9, cs.length, 200);
const all = [...cs, ...capChars];
p._summaryManager.setCharsDataList(all);
const matched = p.bboxMatch([{ page_idx: 0, blocks: [
  { type: "text", page_idx: 0, text: source, bbox: [0, 0, 600, 800] },
  { type: "image", page_idx: 0, text: caption, bbox: [40, 250, 400, 650] },
] }], [], all);
assert.equal(matched[0].paragraphs[0].text.trim(), source);
assert.ok(matched[0].paragraphs[1].charMapping.length > 0, "caption outside image box is matched");
assert.equal(matched[0].paragraphs[1].typography.fontSize, 9);
const paragraphs = p.processSentenceData(matched).map((x) => ({ ...x, point_split: [x.sentences.map((_, i) => i)], point_translations: ["译文"] }));
p._summaryManager.buildHierarchicalData(paragraphs);
const image = p._summaryManager.hierarchicalData[0].paragraphs[1];
assert.equal(image.typography.fontSize, 9);
assert.ok(image.rects.every((r) => r[3] - r[1] <= 10), "caption uses text lines, not figure bounds");

const separated = [...chars("First part ", 10, 0, 0, 700), ...chars("AXIS LABEL", 10, 0, 11, 400), ...chars("second part.", 10, 0, 21, 680)];
const clean = p._extractTextByBbox(separated, { type: "text", page_idx: 0, text: "First part second part.", bbox: [0, 0, 600, 800] }, [{ bbox: [0, 390, 600, 420] }]);
assert.ok(!clean.text.includes("AXIS"), clean.text);
p._summaryManager.setCharsDataList(separated);
const rects = p._summaryManager._getSentenceRectsFromCharMapping(clean.charMapping);
assert.ok(rects.every((r) => r[1] > 600), "excluded chars cannot reappear in hover rects");

const overlay = Object.create(D.Overlay.prototype);
const geom = { t: [1, 0, 0, -1, 0, 800], w: 600, h: 800, div: { clientWidth: 600 } };
const fallback = overlay._lineMetrics(geom, { paragraphType: "image", rects: [[40, 200, 400, 650]] });
assert.ok(fallback.fontSize <= 12, "old results: image height cannot become font size");
const normal = overlay._lineMetrics(geom, { paragraphType: "text", typography: { fontSize: 10 }, rects: [[40, 700, 400, 710]] });
assert.equal(normal.fontSize, 10);
geom.div.clientWidth = 1200;
assert.equal(overlay._lineMetrics(geom, { paragraphType: "image", typography: { fontSize: 9 }, rects: [[40, 200, 400, 650]] }).fontSize, 18);
console.log("typography: style alignment, MinerU bounds, captions, persisted metrics and zoom passed");

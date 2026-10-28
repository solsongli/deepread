// Retain paragraph/list structure independently of semantic key-point grouping.
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
const D = { log() {}, bilingual: (zh) => zh };
const ctx = vm.createContext({ DeepRead: D, console, setTimeout, clearTimeout, AbortController });
for (const f of ["services/typography", "services/translationLayout", "pipeline/summaryManager", "pipeline/pipeline", "reader/session"]) {
  vm.runInContext(fs.readFileSync(new URL(`../addon/content/scripts/${f}.js`, import.meta.url), "utf8"), ctx);
}
const T = D.TranslationLayout, plain = (v) => JSON.parse(JSON.stringify(v));
function source(lines) {
  const chars = [];
  lines.forEach(([text, x, y, bold = 0]) => [...text].forEach((u, i) => chars.push({
    u, c: u, offset: chars.length, fontName: i < bold ? "Times-Bold" : "Times-Roman", fontSize: 10,
    rect: [x + i * 4, y, x + (i + 1) * 4, y + 10], lineBreakAfter: i === text.length - 1,
  })));
  const formatted = D.Pipeline.prototype._extractFormattedText(chars);
  return { chars, ...formatted };
}
const input = source([
  ["• Closed-loop action sequences. We combine the policy", 40, 700, 31],
  ["with receding-horizon control to achieve robust execution.", 52, 688],
  ["This preserves temporal consistency during planning.", 52, 676],
  ["• Visual conditioning. We encode visual observations", 40, 660, 22],
  ["as conditioning rather than the action distribution.", 52, 648],
  ["This enables real-time action inference.", 52, 636],
]);
const list = T.analyze(input.text, input.charMapping, input.chars);
assert.equal(list.units.length, 2);
assert.ok(list.units.every((u) => u.kind === "list-item" && u.marker === "•"));
assert.ok(list.units[0].styledText.includes("**Closed-loop") || list.units[0].styledText.includes("**• Closed-loop"));
assert.equal(list.units[0].hangingEm, 1.2);
const matched = D.Typography.match(input.chars, input.text);
assert.equal(matched[0].u, "•", "the first bullet must survive normalized source matching");

const prose = source([
  ["Sequence prediction is often avoided in policy learning", 60, 700],
  ["methods due to difficulties in sampling from high dimensions.", 50, 688],
  ["This affects the number of modes and means steps.", 50, 676],
  ["In contrast, DDPM scales well with output dimensions", 60, 660],
  ["without sacrificing model expressiveness.", 50, 648],
  ["It naturally addresses the following issues:", 50, 636],
]);
const paragraphs = T.analyze(prose.text, prose.charMapping, prose.chars);
assert.equal(paragraphs.units.length, 2);
assert.ok(paragraphs.units.every((u) => u.kind === "paragraph" && u.indentEm === 1));
assert.ok(Math.abs(paragraphs.units.reduce((n, u) => n + u.share, 0) - 1) < 0.001);
const wrapped = source([["One sentence wraps without", 50, 700], ["starting a new paragraph.", 50, 688], ["Another sentence in the same paragraph.", 50, 676]]);
assert.equal(T.analyze(wrapped.text, wrapped.charMapping, wrapped.chars).units.length, 1, "soft PDF wraps are not paragraph breaks");
assert.equal(T.analyze("Figure 1: caption", [], [], { type: "image" }), null);
assert.equal(T.analyze("Body and display equation", [], [], { type: "text_with_equation" }), null);
assert.ok(T.analyze("•First item\n\n•Second item", [], [], { type: "list" }).units.every((u) => u.marker === "•"));
assert.equal(T.accept(list, [{ unit_id: "u0", translation: "缺少第二项" }]), null);
assert.equal(T.accept(list, [{ unit_id: "u0", translation: "a" }, { unit_id: "u0", translation: "b" }]), null, "duplicate IDs are rejected");

const translated = T.accept(list, [{ unit_id: "u1", translation: "• **视觉条件。** 第二项。" }, { unit_id: "u0", translation: "**闭环动作序列。** 第一项。" }]);
assert.equal(translated.units[0].translation, "**闭环动作序列。** 第一项。");
assert.equal(translated.units[1].translation, "**视觉条件。** 第二项。");
assert.equal(T.markdown(translated), "• **闭环动作序列。** 第一项。\n\n• **视觉条件。** 第二项。");
let calls = 0;
const restored = await T.complete([{ translationLayout: paragraphs, points: [{ translation: "旧的混合译文", sentenceIndices: [0, 1] }], sentences: [{ text: prose.text }] }], {
  request: async (args) => {
    calls++;
    const items = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
    assert.equal(items.length, 2);
    assert.ok(items[0].source_text.startsWith("Sequence"));
    assert.ok(items[1].source_text.startsWith("In contrast"));
    return { content: JSON.stringify({ translations: items.map((u, i) => ({ id: u.id, translation: `第${i + 1}段译文。` })) }) };
  },
});
assert.equal(calls, 1);
assert.ok(T.ready(restored[0].translationLayout));
const cached = await T.complete(restored, { request: () => { throw new Error("should not request again"); } });
assert.deepEqual(plain(cached), plain(restored));
const compact = D.Session.compactHierarchicalData([{ pageIndex: 0, paragraphs: [{ paragraphIndex: 0, translationLayout: translated, translationLayoutVersion: 1 }] }]);
assert.equal(compact[0].paragraphs[0].translationLayout.units[1].marker, "•");
assert.equal(compact[0].paragraphs[0].translationLayoutVersion, 1);
console.log("translationLayout: list markers, paragraph boundaries, soft wraps, unit identity, translations and persistence passed");

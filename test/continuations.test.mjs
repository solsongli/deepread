// Joint translation retains source coordinates and rejects unrelated boundaries.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const D = { prefs: { get() {}, language: () => "zh" }, log() {}, bilingual: (zh) => zh };
const scope = vm.createContext({ DeepRead: D, console, AbortController, setTimeout, clearTimeout });
for (const f of ["services/continuations", "services/cardGroups", "pipeline/summaryManager", "pipeline/pipeline", "reader/session", "reader/overlay"]) {
  vm.runInContext(fs.readFileSync(new URL(`../addon/content/scripts/${f}.js`, import.meta.url), "utf8"), scope);
}
const C = D.Continuations, plain = (v) => JSON.parse(JSON.stringify(v));
const para = (page, index, text, bbox, type = "text") => ({ page_idx: page, paragraph_idx: index, paragraph_type: type,
  paragraph_text: text, text, bbox, typography: { fontSize: 10 }, sentences: [{ text }],
  point_translations: [`old ${page}:${index}`] });
const a = para(0, 4, "We use the learned representation to improve the", [80, 760, 460, 910]);
const b = para(1, 0, "Transformer predictions without changing the objective.", [80, 100, 460, 240]);
assert.equal(C.candidates([a, b]).length, 1, "uppercase technical term can continue a sentence");
assert.equal(C.candidates([{ ...a, paragraph_text: a.paragraph_text + "." }, { ...b, bbox: [80, 700, 460, 900] }]).length, 0, "complete paragraphs at unrelated positions are not candidates");
assert.equal(C.candidates([{ ...a, bbox: [80, 300, 460, 450] }, b]).length, 1, "an unfinished sentence can continue after a nonstandard page break");
assert.equal(C.candidates([a, para(1, 0, "New section", [80, 60, 460, 90], "title"), { ...b, paragraph_idx: 1 }]).length, 0, "heading is a hard boundary");
assert.equal(C.candidates([a, { ...b, page_idx: 2 }]).length, 0, "do not skip pages");
const top = para(0, 0, "The network combines two feature representations to improve", [80, 150, 460, 240]);
const fig = para(0, 1, "Figure 1: this caption must stay separate", [80, 280, 460, 580], "image");
const bottom = para(0, 2, "the accuracy of its predictions on unseen samples.", [80, 620, 460, 720]);
assert.equal(C.candidates([top, fig, bottom]).length, 1);
assert.equal(C.candidates([fig, top, bottom]).length, 1, "floating image may be listed before both text fragments");
assert.equal(C.candidates([top, bottom], { visuals: [fig] }).length, 1, "uncaptioned visual can come from the parser content list");
assert.equal(C.candidates([top, { ...fig, paragraph_type: "text" }, bottom]).length, 1, "a separate caption is excluded from paragraph text");
assert.equal(C.candidates([top, fig, { ...bottom, bbox: [540, 620, 920, 720] }]).length, 0, "different columns are not joined across a figure");
assert.equal(C.candidates([top, para(0, 1, "x = 1", fig.bbox, "equation"), bottom]).length, 0);
let calls = 0;
const joined = await C.reconcile([top, fig, bottom], { complete: async (args) => {
  calls++;
  const payload = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
  assert.equal(payload[0].parts.length, 2);
  assert.ok(args.messages[0].content.includes(top.paragraph_text) && args.messages[0].content.includes(bottom.paragraph_text));
  assert.ok(!args.messages[0].content.includes("this caption must stay separate"));
  return { content: JSON.stringify({ groups: [{ keys: ["p_0_0", "p_0_2"], translation: "网络融合两种特征表示，以提升对未见样本的预测准确率。" }] }) };
} });
assert.equal(calls, 1);
assert.equal(joined.count, 1);
assert.deepEqual(plain(joined.paragraphs[0].bbox), top.bbox);
assert.deepEqual(plain(joined.paragraphs[2].bbox), bottom.bbox);
assert.equal(joined.paragraphs[1].continuation, undefined);
assert.equal(joined.paragraphs[2].continuation.lead, "p_0_0");
assert.equal(joined.paragraphs[0].point_translations[0], top.point_translations[0], "independent fallback translations are retained");
await C.reconcile(joined.paragraphs, { complete: () => { throw new Error("checked cache must not call the model again"); } });
const no = await C.reconcile([a, b], { complete: async () => ({ content: '{"groups":[]}' }) });
assert.equal(no.count, 0, "semantic rejection keeps paragraphs separate");
const bad = await C.reconcile([a, b], { complete: async () => ({ content: '{"groups":[{"keys":["p_1_0","p_0_4"],"translation":"bad"}]}' }) });
assert.equal(bad.count, 0, "response cannot reorder the source");
const failure = await C.reconcile([a, b], { complete: async () => { throw new Error("offline"); } });
assert.equal(failure.failures, 1);
assert.equal(failure.paragraphs[0].continuationChecked, false);
assert.equal(failure.paragraphs[0].point_translations[0], a.point_translations[0]);
const ac = new AbortController();
await assert.rejects(C.reconcile([a, b], { signal: ac.signal, complete: async () => { ac.abort(); return { content: '{"groups":[]}' }; } }), { name: "AbortError" });

const hierarchy = [{ pageIndex: 0, paragraphs: joined.paragraphs.map((p) => ({
  paragraphIndex: p.paragraph_idx, paragraphType: p.paragraph_type, paragraphText: p.paragraph_text, bbox: p.bbox,
  typography: p.typography, continuation: p.continuation, continuationChecked: p.continuationChecked,
  rects: [[40, 100, 300, 120]], points: [{ id: `point${p.paragraph_idx}`, translation: p.point_translations[0], importance_level: 2, importance_source: "model" }],
})) }];
const compact = D.Session.compactHierarchicalData(hierarchy);
assert.equal(compact[0].paragraphs[0].continuation.translation, joined.paragraphs[0].continuation.translation);
assert.equal(compact[0].paragraphs[0].typography.fontSize, 10);
assert.equal(compact[0].paragraphs[0].points[0].importance_source, "model");
const session = Object.create(D.Session.prototype);
Object.assign(session, { data: { hierarchicalData: compact }, explanations: {}, userState: {} });
assert.equal(session.groupLead("p_0_2"), "p_0_0", "confirmed group can cross a visual block");
assert.equal(session.groupLead("p_0_1"), "p_0_1", "figure keeps its own card");
const overlay = Object.create(D.Overlay.prototype); overlay.session = session;
const ps = compact[0].paragraphs.map((p) => ({ ...p, pageIndex: 0 }));
assert.equal(overlay._paragraphTranslation(ps[0]), overlay._paragraphTranslation(ps[2]));
assert.equal(overlay.translationsFor([ps[0], ps[2]]).length, 1, "one translation in a merged card");
session.userState.cardGroups = { p_0_0: ["p_0_0"], p_0_2: ["p_0_2"] }; session._cardGroups = null;
assert.equal(overlay._paragraphTranslation(ps[2]), bottom.point_translations[0], "manual split restores independent translation");

// The pipeline really requests one joint translation after the ordinary page results.
const pipeline = new D.Pipeline({ llm: async () => ({ content: '{"groups":[{"keys":["p_0_4","p_1_0"],"translation":"一份跨页的连贯译文。"}]}' }) });
pipeline._generateSummaryAndTranslationByPage = async () => [a, b];
const output = await pipeline.llmRequest([a, b]);
assert.equal(output[1].continuation.lead, "p_0_4");
assert.equal(output[0].continuation.translation, "一份跨页的连贯译文。");
let finish, writes = 0;
D.LLM = { isConfigured: () => true, complete: () => new Promise((resolve) => { finish = resolve; }) };
D.Store = { savePaper: async () => { writes++; } };
session.data = { hierarchicalData: compact.map((page) => ({ ...page, paragraphs: page.paragraphs.map((p) => ({ ...p, continuation: null, continuationChecked: false })) })) };
const pending = session.mergeContinuationTranslations();
session.data = { hierarchicalData: [] }; // cleared/reparsed while the model was running
finish({ content: '{"groups":[]}' });
assert.equal(await pending, 0);
assert.equal(writes, 0, "a stale completion must not overwrite newer or cleared results");
console.log("continuations: page/figure detection, joint request, rejection, abort, source geometry, persistence and single display passed");

// Goals, evidence notes, adjustable highlights and safe reparsing.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const scope = { DeepRead: { prefs: { get() {} }, bilingual: (zh) => zh }, console, setTimeout, clearTimeout };
vm.createContext(scope);
for (const file of ["services/reading", "services/highlights", "reader/session"]) {
  vm.runInContext(fs.readFileSync(new URL(`../addon/content/scripts/${file}.js`, import.meta.url), "utf8"), scope);
}
const D = scope.DeepRead, plain = (v) => JSON.parse(JSON.stringify(v));
const paragraph = (i, text) => ({ paragraphIndex: i, paragraphType: "text", paragraphText: text });
const previous = [{ pageIndex: 0, paragraphs: [paragraph(0, "Exact original paragraph."), paragraph(1, "Changed by OCR."), paragraph(2, "Repeated"), paragraph(3, "Edited summary source")] }];
const next = [{ pageIndex: 1, paragraphs: [paragraph(7, "Exact original paragraph."), paragraph(9, "Repeated"), paragraph(10, "Repeated"), paragraph(11, "Edited summary source")] }];
const state = { readingGoal: { kind: "method", text: "Why does this design matter?" }, highlightDensity: "sparse",
  recallAnswers: { q1: { question: "Why?", text: "My explanation" } },
  figureNotes: { "fig:1": { observation: "Group A has larger values", interpretation: "The figure does not establish causation." } },
  notes: { p_0_0: { text: "Move me" }, p_0_1: { text: "Keep me, unaligned" }, p_0_2: { text: "Do not guess" } },
  edits: { p_0_3: "Edited by me" }, pointImportance: { old: 3 }, cardGroups: { p_0_0: ["p_0_0", "p_0_1"] } };
const copy = JSON.stringify(state);
const migrated = D.Reading.carryState(state, previous, next);
assert.equal(JSON.stringify(state), copy, "migration must not mutate old state");
assert.equal(migrated.notes.p_1_7.text, "Move me");
assert.deepEqual(plain(migrated.unmappedNotes.map((n) => n.text)), ["Keep me, unaligned", "Do not guess"]);
assert.deepEqual(plain(migrated.figureNotes), state.figureNotes);
assert.deepEqual(plain(migrated.readingGoal), state.readingGoal);
assert.deepEqual(plain(migrated.recallAnswers), state.recallAnswers);
assert.equal(migrated.edits.p_1_11, "Edited by me");
assert.deepEqual(plain(migrated.pointImportance), {}, "old point ids must not attach to new sentences");
assert.deepEqual(plain(migrated.cardGroups), {}, "old numeric group ids must not merge new paragraphs");
assert.equal(D.Reading.carryState(migrated, next, next).unmappedNotes.length, 2, "repeat parse must not duplicate unaligned notes");

const sections = [{ role: "method", label: "Methods", start: 2.2 }, { role: "experiment", label: "Results", start: 4 }];
assert.deepEqual(plain(D.Reading.targets("method", sections).map((t) => t.section.label)), ["Methods", "Results"]);
assert.equal(D.Reading.targets("unknown", sections).length, 0);
assert.equal(D.Reading.targets("evidence", [], [{ id: "fig:1" }])[0].kind, "figure");
assert.equal(D.Reading.targets("reproduce", []).length, 0, "missing sections are not invented");

const pages = [{ pageIndex: 0, paragraphs: Array.from({ length: 10 }, (_, i) => ({
  ...paragraph(i, "This is a sufficiently detailed text paragraph explaining a result of the paper."),
  points: [{ id: `pt${i}`, importance_source: "model", importance_level: i === 9 ? 1 : 2,
    summary: "summary", rects: [[0, i * 10, 20, i * 10 + 8]] }],
})) }];
const select = (density) => D.Highlights.select(pages, { density });
assert.equal(select("manual").size, 0);
assert.equal(select("sparse").size, 1);
assert.equal(select("standard").size, 2);
assert.equal(select("detailed").size, 4);
assert.ok([...select("sparse").keys()].every((k) => select("standard").has(k)));
assert.ok([...select("standard").keys()].every((k) => select("detailed").has(k)));
assert.equal(select("detailed").has("pt9"), false, "do not promote a model's ordinary point");
const focused = D.Highlights.select(pages, { density: "sparse", goal: "method", roleOf: (k) => k === "p_0_7" ? "method" : "result" });
assert.deepEqual([...focused.keys()], ["pt7"]);

const session = Object.create(D.Session.prototype);
Object.assign(session, { data: { hierarchicalData: pages }, userState: {}, explanations: {}, overlay: { renderAllPages() {} }, _saveUserStateSoon() {}, _listeners: new Set() });
session.setHighlightDensity("manual");
assert.equal(session.highlightLevel(pages[0].paragraphs[0].points[0]), 1);
session.userState.pointImportance = { pt0: 3, pt1: 1 };
assert.equal(session.highlightLevel(pages[0].paragraphs[0].points[0]), 3, "manual marks survive manual-only mode");
session.setHighlightDensity("detailed");
assert.equal(session.highlightLevel(pages[0].paragraphs[1].points[0]), 1, "manual removal survives density changes");
session.setReadingGoal("method", "A local question");
assert.equal(session.userState.readingGoal.kind, "method");
session.setReadingGoal("invalid", "Keep this text");
assert.equal(session.userState.readingGoal.kind, "");
assert.equal(session.userState.readingGoal.text, "Keep this text");
console.log("readingMethods: safe reparse migration, goal routes, nested highlight densities and manual overrides passed");

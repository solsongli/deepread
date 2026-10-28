// Reading flow regressions: grouping, explicit toggles, sparse highlights and preservation.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const prefs = new Map([["cards.keepOpen", true], ["cards.autoExplain", false], ["cards.groupParagraphs", true]]);
const scope = { DeepRead: { prefs: { get: (k) => prefs.get(k) } }, console, setTimeout, clearTimeout };
vm.createContext(scope);
for (const name of ["services/cardGroups", "services/highlights", "reader/overlay", "reader/rail", "reader/session"]) {
  vm.runInContext(fs.readFileSync(new URL(`../addon/content/scripts/${name}.js`, import.meta.url), "utf8"), scope);
}
const D = scope.DeepRead, plain = (v) => JSON.parse(JSON.stringify(v));
const paragraph = (i, text, top = 700, type = "text") => ({ paragraphIndex: i, paragraphType: type, paragraphText: text,
  rects: [[50, top - 10, 280, top]], typography: { fontSize: 10 },
  points: [{ id: `0_${i}_point_0`, summary: "key", importance_level: 1, rects: [[50, top - 10, 280, top]] }] });
const p0 = paragraph(0, "The proposed method combines two complementary representations to improve");
const p1 = paragraph(1, "the accuracy of the model on the main task, without extra data.", 684);
const p2 = paragraph(2, "A separate result provides evidence for a different part of the argument.", 650);
const pages = [{ pageIndex: 0, paragraphs: [p0, p1, p2] }];
let groups = D.CardGroups.build(pages);
assert.deepEqual(plain(groups.groups.get("p_0_0")), ["p_0_0", "p_0_1"]);
assert.equal(groups.leads.get("p_0_2"), "p_0_2", "a complete sentence starts a new card");
assert.equal(D.CardGroups.continues({ ...p0, pageIndex: 0 }, { ...p1, pageIndex: 1 }), false, "cross-page grouping requires translation confirmation");
assert.equal(D.CardGroups.continues({ ...p0, pageIndex: 0 }, { ...p1, pageIndex: 0, rects: [[330, 674, 560, 684]] }), false, "do not merge unrelated columns");
const withHeading = [{ pageIndex: 0, paragraphs: [p0, paragraph(9, "Methods", 690, "title"), p1] }];
groups = D.CardGroups.build(withHeading, { p_0_0: { members: ["p_0_0", "p_0_1"] } });
assert.equal(groups.leads.get("p_0_1"), "p_0_1", "heading is a hard boundary even for AI groups");

const session = Object.create(D.Session.prototype);
Object.assign(session, { data: { hierarchicalData: pages }, userState: { pointImportance: {}, notes: { p_0_1: { text: "my note" } } },
  explanations: { p_0_0: { text: "Explanation A" }, p_0_1: { text: "Explanation B" }, p_0_2: { text: "Explanation C" } },
  _listeners: new Set(), _saveUserStateSoon() {}, rail: null });
assert.equal(session.explanation("p_0_0"), "Explanation A\n\nExplanation B");
session.mergeCardWithPrevious("p_0_2");
assert.deepEqual(plain(session.groupMembers("p_0_2")), ["p_0_0", "p_0_1", "p_0_2"]);
assert.equal(session.paragraphNote("p_0_1"), "my note");
session.splitCard("p_0_0");
assert.deepEqual(plain(session.groupMembers("p_0_1")), ["p_0_1"]);
assert.equal(session.explanation("p_0_1"), "Explanation B");
session._cardGroups = null; // simulate a reopen from serialized state
session.userState = plain(session.userState);
assert.equal(session.groupLead("p_0_1"), "p_0_1", "manual split persists over automatic grouping");

const rail = Object.create(D.Rail.prototype);
Object.assign(rail, { session, expanded: new Set(), focusKey: null, _invalidate() {}, schedule() {} });
const block = { ...p0, pageIndex: 0 };
rail.openParagraph(block, { toggle: true });
assert.equal(rail.isOpen("p_0_0"), true);
rail.openParagraph(block, { toggle: true });
assert.equal(rail.isOpen("p_0_0"), false, "second source click closes focused card");
rail.openParagraph(block);
rail.openParagraph({ ...p2, pageIndex: 0 });
rail.openParagraph(block, { toggle: true });
assert.equal(rail.isOpen("p_0_0"), false, "keep-open cards also close on source click");
rail.openParagraph(block);
rail.openParagraph(block);
assert.equal(rail.isOpen("p_0_0"), true, "programmatic navigation always opens");
session.userState.cardGroups = { p_0_0: ["p_0_0", "p_0_1"], p_0_1: ["p_0_0", "p_0_1"] };
session._cardGroups = null;
rail.openParagraph({ ...p1, pageIndex: 0 }, { toggle: true });
assert.equal(rail.isOpen("p_0_0"), false, "clicking a follower toggles the same merged card");

const defaults = D.Highlights.defaults(pages, (key) => key === "p_0_2" ? "result" : "background");
assert.deepEqual([...defaults], ["0_2_point_0"], "legacy fallback is sparse and prefers evidence");
assert.equal(session.pointLevel(p0.points[0]), 2, "old results show a suggestion without rerunning AI");
session.userState.pointImportance[p0.points[0].id] = 1;
assert.equal(session.pointLevel(p0.points[0]), 1, "explicit removal beats suggestions");
assert.equal(session.pointLevel({ id: "model-plain", importance_level: 1, importance_source: "model" }), 1);
assert.equal(session.pointLevel({ id: "model-key", importance_level: 3, importance_source: "model" }), 3);
console.log("readingFlow: grouping, note preservation, toggles, explicit navigation and sparse highlights passed");

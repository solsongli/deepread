// Semantic roles and column flow are observable in the reader and the printed PDF.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const scope = vm.createContext({ DeepRead: {} });
for (const name of ["services/paperStyles", "reader/parallelFlow", "services/printGrid"]) {
  vm.runInContext(
    fs.readFileSync(new URL("../addon/content/scripts/" + name + ".js", import.meta.url), "utf8"),
    scope
  );
}
const S = scope.DeepRead.PaperStyles,
  F = scope.DeepRead.ParallelFlow;
const profile = S.make(10),
  style = profile.roles;
const source = [
  { id: 0, page_idx: 0, type: "text", text: "Learning with examples", text_level: 1 },
  { id: 1, page_idx: 0, type: "text", text: "Introduction", text_level: 2 },
  { id: 2, page_idx: 0, type: "text", text: "Experimental design", text_level: 3 },
  { id: 3, page_idx: 6, type: "text", text: "References", text_level: 2 },
  { id: 4, page_idx: 7, type: "text", text: "An author, a paper and a journal." },
  { id: 5, page_idx: 8, type: "text", text: "Appendix", text_level: 2 }
];
const structure = S.documentStructure(source);
const role = (s, props = {}) => S.role({ source: s, role: "text", size: 10, ...props }, profile, structure);
assert.equal(role("Learning with examples", { owner: 0, title: true }), "documentTitle");
assert.equal(role("Experimental design", { title: true, headingLevel: 3, size: 10.5 }), "subheading");
assert.equal(role("2 Data", { title: true, headingLevel: 2 }), "heading");
assert.equal(role("B.4 Preparation", { title: true }), "subheading");
assert.equal(role("I. INTRODUCTION", { title: true }), "heading");
assert.equal(role("8 DISCUSSION AND CONCLUSIONS", { rects: [[]] }), "heading");
assert.equal(S.sourceFamily("YBVNGW+LinBiolinumT"),"sans");
assert.equal(S.sourceFamily("ZVRVUE+LinLibertineT"),"serif");
assert.equal(
  role("C. Benefits of Action-Sequence Prediction", { title: true, allItalic: true }),
  "subheading"
);
assert.equal(role("Observations", { title: true, headingLevel: 2 }), "heading");
assert.equal(
  role("Table 2 summarizes the results.", { styled: "**Table 2** summarizes the results." }),
  "body"
);
assert.equal(role("Figure 3: Measured response."), "figureCaption");
assert.equal(S.styleFor({typeRole:"figureCaption",fontFamily:"serif"},profile).weight,550);
assert.equal(S.styleFor({typeRole:"tableCaption",fontFamily:"sans"},profile).weight,500);
assert.equal(S.make(10,12,"en").roles.figureCaption.weight,400);
assert.equal(role("Physical parameters", { role: "caption", captionKind: "table" }), "tableCaption");
assert.equal(role("A further note.", { role: "caption", captionKind: "footnote" }), "footnote");
const contributionFootnote = {role:"text",source:"∗Equal contribution. Listing order is random.",
  size:8, rect:[108,105,504,194],rects:[[108,185,504,194],[108,105,504,114]]};
S.classify([contributionFootnote],profile,structure,[0,0,612,792]);
assert.equal(contributionFootnote.typeRole,"footnote","a long starred author note keeps the footnote scale");
{
  const labels = [60, 155, 250].map(x => ({
    role:"text", source:"Caption underneath a single frame.", matched:true, placed:true, size:5,
    rect:[x,510,x+72,523], rects:[[x,517,x+72,523],[x,510,x+45,516]]
  }));
  const prose = {...labels[0], size:10, rect:[60,410,320,465], rects:[[60,452,320,465],[60,410,265,421]]};
  S.classify([...labels,prose],profile,structure,[0,0,612,792]);
  assert.ok(labels.every(label => label.role === "figure_label" && label.verifiedLabel));
  assert.equal(prose.typeRole,"body");
}
assert.equal(role("An author, a paper and a journal.", { owner: 4 }), "reference");
assert.equal(role("Average", { role: "table_label", verifiedLabel: true }), null);
assert.equal(role("Experimental design", { layoutPart: "contents" }), "contents");
assert.equal(role("A running paper title", { role:"header",layoutPart:"runningTitle" }), "runningTitle");
assert.equal(S.styleFor({typeRole:"runningTitle",boldTitle:true},profile).weight,700);

const rect = [100, 650, 460, 703];
const refs = S.documentStructure([
  { page_idx: 0, type: "text", text: "Ordinary prose above the references.", bbox: [50, 150, 440, 640] },
  { page_idx: 0, type: "text", text_level: 1, text: "References", bbox: rect },
  { page_idx: 0, type: "text", text: "[1] A. Author. Paper.", bbox: rect },
  { page_idx: 1, type: "text", text: "[2] B. Author. Report.", bbox: rect },
  { page_idx: 1, type: "text", text_level: 1, text: "Appendix", bbox: rect },
  { page_idx: 1, type: "text", text: "Body of the appendix.", bbox: rect },
  { page_idx: 2, type: "ref_text", text: "[3] C. Author. Report.", bbox: rect }
]);
assert.equal(refs.referenceBoxes.get(0).length, 2);
assert.equal(refs.referenceBoxes.get(1).length, 1);
assert.equal(refs.referenceBoxes.get(2).length, 1);
const lostHeading = S.documentStructure([
  {id:1,page_idx:4,type:"text",text:"Above the references, this remains ordinary prose.",bbox:[50,30,440,150]},
  {id:2,page_idx:4,type:"text",text:"[1] B. Smith and J. Hu, “Robot learning,” 2023.",bbox:[50,160,440,235]},
  {id:3,page_idx:4,type:"text",text:"[2] M. Kim et al., “Visual control,” 2024.",bbox:[50,240,440,310]},
  {id:4,page_idx:5,type:"text",text:"[3] S. Wu et al., “A third paper,” 2025.",bbox:[50,80,440,220]},
  {id:5,page_idx:6,type:"text",text:"Appendix A",text_level:1,bbox:[50,80,440,140]}
]);
assert.equal(lostHeading.referenceBoxes.get(4).length,2);
assert.equal(lostHeading.referenceBoxes.get(5).length,1);
assert.equal(lostHeading.referenceBoxes.has(6),false);
const splitPage = S.documentStructure([
  {page_idx:11,type:"text",text:"for document retrieval. In Proceedings of ACL.",bbox:[90,30,450,50]},
  {page_idx:11,type:"text",text:"Wei Wang, Ming Yan, and Chen Wu. 2018b. Attention fusion.",bbox:[90,60,450,130]},
  {page_idx:11,type:"text",text:"Alex Warstadt, Adina Williams, and Samuel Bowman. 2018. Judgments.",bbox:[90,150,450,225]},
  {page_idx:11,type:"text",text:"Appendix for a language model",text_level:1,bbox:[510,30,930,72]}
]);
assert.equal(splitPage.referenceBoxes.get(11).length,3);

const line = (value, fontSize) =>
  Array.from(value, (u, i) => ({ u, fontSize, lineBreakAfter: i + 1 === value.length }));
const raw = [
  ...line("This is a sufficiently long line of ordinary running prose.", 10),
  ...line("Title", 18),
  ...line("0.8 1.0 1.2", 5)
];
const counts = new Map();
S.countPage(raw, 1, counts);
assert.equal([...counts.keys()].join(","), "10");
let reads = 0;
const session = {
  overlay: { app: { pdfDocument: { numPages: 8 } } },
  pdfAdapter: () => ({
    pdfDocument: {
      numPages: 8,
      getPageData: async () => {
        reads++;
        return { chars: raw };
      },
      getPage: async () => ({ getViewport: () => ({ transform: [1, 0, 0, -1, 0, 700] }) })
    }
  })
};
const picked = await Promise.all([S.resolve(session), S.resolve(session)]);
assert.equal(picked[0], picked[1]);
assert.equal(picked[0].base, 10);
assert.ok(reads > 1 && reads <= 6);
await S.resolve(session);
assert.ok(reads <= 6, "opening a later page reuses the document type scale");

const geometry = (top, left = 20, width = 160, height = 40) => ({ left, top, width, height });
const paragraph = (top, n = 2, props = {}) => ({
  style: style.body,
  angle: 0,
  unit: { source: "Complete paragraph.", rects: [[], []] },
  rect: geometry(top),
  metrics: { height: n * 15, inkHeight: n * 15 - 3, wide: false },
  ...props
});
const page = { width: 400, height: 500, styleProfile: profile };
const a = paragraph(40),
  b = paragraph(90, 3),
  c = paragraph(143, 1),
  other = paragraph(40, 2, { rect: geometry(40, 210) });
F.arrange([a, other, b, c], page, () => false);
assert.deepEqual(
  [a.top, b.top, c.top, other.top],
  [40, 90, 143, 40],
  "a shorter translation leaves the following paragraph at its source position in each column"
);
assert.equal(a.overflow, false);
assert.equal(c.overflow, false);
const above = paragraph(20, 4, {
  metrics: {
    height: 60,
    inkHeight: 57,
    wide: false,
    lines: [0, 15, 30, 45].map((top) => ({ left: 0, top, width: 160, height: 12 }))
  }
});
const below = paragraph(82);
F.arrange([above, below], page, (r) => r.top < 70 && r.top + r.height > 66);
assert.equal(below.top, 82, "text below fixed artwork keeps its own source position");
assert.ok(above.overflow && above.top + above.height <= 66, "the final row cannot paint across a rule");
const huge = paragraph(40, 60);
F.arrange([huge], page, () => false);
assert.equal(huge.overflow, true);
assert.equal(
  huge.style.size,
  style.body.size,
  "even a passage needing a supplement keeps its document font size"
);
const anchors = [{ role: "heading", source: geometry(100, 24, 160, 15), dx: 0, dy: -12 }];
assert.equal(F.destination(anchors, "section.2", 24, 92).y, 80);
assert.equal(F.destination(anchors, "equation.2", 24, 92).y, 92);
console.log(
  "paperStyles: document font sampling, distinct semantic roles, real caption ownership, column gaps and fixed artwork passed"
);

const centered = paragraph(30, 1, {
  style: style.heading,
  unit: { source: "Abstract", centered: true, rects: [[]] },
  rect: geometry(30, 75, 50, 14)
});
const insetBody = paragraph(57);
F.arrange([centered, insetBody], page, () => false);
assert.equal(
  centered.paintRect.left + centered.paintRect.width / 2,
  insetBody.paintRect.left + insetBody.paintRect.width / 2
);
assert.equal(insetBody.top, 57, "a short heading does not pull its paragraph upward");

const gridLine = (baseline) => ({ size: 10, ux: 1, uy: 0, left: 8, right: 140, baseline });
const anchorsForPrint = [gridLine(20), gridLine(35)];
const printed = String.raw`1 0 0 -1 0 100 cm q BT
10 0 0 -10 10 20.4 Tm /f0 1 Tf [(a (2 3 Td) \(Tm\))]TJ
0 -1.5 Td <00ab>Tj
22 0 Td (outside the translated frame)Tj ET Q`;
const snapped = scope.DeepRead.PrintGrid.snap(printed, anchorsForPrint, { x: 0, y: 0, height: 100 });
assert.ok(snapped.includes("10 0 0 -10 10 20 Tm") && snapped.includes("10 0 0 -10 10 35 Tm"));
assert.ok(
  snapped.includes("10 0 0 -10 230 35.4 Tm"),
  "a following relative command outside the grid retains its original position"
);
assert.ok(snapped.includes(String.raw`[(a (2 3 Td) \(Tm\))]TJ`), "literal glyph bytes pass through intact");
assert.equal(
  scope.DeepRead.PrintGrid.snap(printed + " BI ", anchorsForPrint, { x: 0, y: 0, height: 100 }),
  null,
  "unsupported print operators leave the original stream intact"
);

function narrowHeading() {
  const entry = paragraph(35, 2, {
    style: style.heading,
    rect: geometry(35, 20, 48, 14),
    unit: { source: "2 Score", rects: [[]] }
  });
  entry.metrics.lines = [{}, {}];
  entry.metrics.rewrap = (width) => ({
    height: 15,
    inkHeight: 12,
    wide: false,
    lines: [{ left: 0, top: 0, width, height: 12 }]
  });
  return entry;
}
const narrow = narrowHeading();
F.arrange([narrow, paragraph(62)], page, () => false);
assert.equal(
  narrow.metrics.lines.length,
  1,
  "a one-line heading uses available column width at its original font size"
);
const blocked = narrowHeading();
F.arrange([blocked, paragraph(62)], page, (r) => r.left >= 68 && r.top === 35);
assert.equal(blocked.frame.width, 48, "a figure or rule beside the heading keeps its original area");

const short = paragraph(40, 2, { rect: geometry(40, 20, 160, 50) });
const next = paragraph(94);
short.unit.matched = next.unit.matched = true;
F.arrange([short, next], page, () => false);
assert.ok(next.top < 82 && next.top >= short.top + short.height + 2.5,
  "neighboring paragraphs close the excess gap without overlapping");

const first = paragraph(40, 2, { rect: geometry(40, 20, 160, 50) });
const acrossRule = paragraph(94);
first.unit.matched = acrossRule.unit.matched = true;
F.arrange([first, acrossRule], page, r => r.top < 86 && r.top + r.height > 85);
assert.equal(acrossRule.top, 94, "a printed rule keeps the neighboring paragraph at its source position");

// Shorter Chinese paragraphs in a continuous column use a common leading
// and visible paragraph gap, even when the individual line counts differ.
function translatedBody(top, height, rows) {
  const lines = Array.from({length:rows}, (_, i) => ({left:0, top:i*13, width:150, height:10}));
  return paragraph(top,rows,{unit:{source:"Body",matched:true,rects:[[],[]]},rect:geometry(top,20,160,height),
    metrics:{lines,inkHeight:(rows-1)*13+10,wide:false,step:13,setLeading(){}}});
}
const column = [translatedBody(50,70,5),translatedBody(127,35,3),translatedBody(169,45,4)];
F.arrange(column,page,()=>false);
const space = (a,b) => b.top-a.top-a.height;
assert.ok(Math.abs(space(column[0],column[1])-space(column[1],column[2]))<.01);
assert.ok(Math.abs(column.at(-1).top+column.at(-1).height-214)<.01);
assert.equal(column[0].metrics.step,column[2].metrics.step);
function sectionWithShortCopy() {
  const intro=translatedBody(40,94,4);
  const heading=translatedBody(157,13,1);
  heading.style=style.subheading;
  heading.rect.width=65;
  const text=translatedBody(186,70,4);
  return [intro,heading,text];
}
const section=sectionWithShortCopy();
F.arrange(section,page,()=>false);
assert.ok(section[1].top<151 && space(section[0],section[1])<=23*1.45+.01);
assert.ok(space(section[1],section[2])>=16*.8 && space(section[1],section[2])<=16*1.45+.01);
assert.ok(section[0].metrics.step<=section[0].style.size*1.48 && section.every(e=>!e.overflow));
const ruled=sectionWithShortCopy();
F.arrange(ruled,page,r=>r.top<146 && r.top+r.height>145);
assert.equal(ruled[1].top,157,"a rule anchors the heading to its own side");
const pairedSection=sectionWithShortCopy();
const secondColumn=translatedBody(40,130,5);
secondColumn.rect.left=215;
F.arrange([...pairedSection,secondColumn],page,()=>false);
assert.ok(pairedSection[0].metrics.step>section[0].metrics.step &&
  pairedSection[0].metrics.step<=pairedSection[0].style.size*1.65);
assert.ok(space(pairedSection[1],pairedSection[2])<=profile.base*1.5+.01,
  "unused space in a narrow column must not open a large heading-to-body gap");

// A long narrow column can save many more lines in Chinese than a single
// paragraph. Its next section should stay close to the corresponding source.
const longSection=[
  translatedBody(65,64,4),translatedBody(133,187,10),translatedBody(330,12,1),
  translatedBody(346,131,6),translatedBody(481,160,8),translatedBody(653,12,1),
  translatedBody(674,92,4)
];
const longProfile=S.make(11,13.75);
for (const entry of longSection) entry.style=longProfile.roles.body;
for(const i of [2,5]) {
  longSection[i].style=longProfile.roles.heading;
  longSection[i].rect.width=65;
}
F.arrange(longSection,{...page,styleProfile:longProfile,height:842},()=>false);
assert.ok(longSection[5].top>615,"compression below a subsection cannot lift the next heading by a hundred points");
assert.ok(space(longSection[4],longSection[5])<35,"the recovered height is shared across preceding paragraphs");

// A column can also end with several bullet points and no further heading.
// Distribute its remaining space across those breaks, bounding every gap.
const listColumn = Array.from({length:7},(_,i)=>translatedBody(56+i*104,92,5));
F.arrange(listColumn,{...page,height:800},()=>false);
assert.ok(space(listColumn[0],listColumn[1])>1.8*profile.base);
assert.ok(listColumn.slice(1).every((entry,i)=>space(listColumn[i],entry)<=profile.base*2+.01));

const shortTail = narrowHeading();
shortTail.style = style.body;
shortTail.unit.matched = true;
F.arrange([shortTail, paragraph(62)], page, () => false);
assert.equal(shortTail.frame.width, 160, "a short source line can use the rest of its own column");

// The same baseline anchor applies after crop offsets and quarter-turn rotation.
const rotatedSource = geometry(30, 170, 25, 80);
const rotated = paragraph(0, 1, {
  rect: rotatedSource,
  sourceRect: rotatedSource,
  angle: 1,
  unit: { source: "Rotated prose.", rect: [0, 0, 80, 30], sourceBaseline: 23, rects: [[]] },
  metrics: {
    height: 15,
    inkHeight: 12,
    firstBaseline: 9,
    wide: false,
    lines: [{ top: 0, left: 0, width: 66, height: 12 }]
  }
});
F.arrange([rotated], { ...page, transform: [0, 1, 1, 0, 0, 0] }, () => false);
assert.equal(rotated.top + 9, page.width - (170 + 25) + 7);
const wide = paragraph(52, 2, { rect: geometry(52, 20, 320, 35) });
const narrowBody = paragraph(10, 2, { rect: geometry(10, 20, 130, 39) });
const afterFloat = paragraph(102, 2, { rect: geometry(102, 20, 320, 35) });
F.arrange([afterFloat, wide, narrowBody], page, () => false);
assert.deepEqual(
  [narrowBody.top, wide.top, afterFloat.top],
  [10, 52, 102],
  "the column transition and next paragraph retain their own anchors"
);
const pitches = new Map(),
  sample = [0, 1, 2, 3, 4, 5].flatMap((i) =>
    line("A long line of normal size text for this paragraph", 10).map((c, j) => ({
      ...c,
      rect: [j * 5, 280 - i * 12, j * 5 + 5, 290 - i * 12],
      baseline: 282 - i * 12
    }))
  );
S.countPage(sample, 1, new Map(), pitches);
assert.equal(pitches.get(10).get(12), 5);
assert.equal(S.make(10, 12).roles.body.step, 12.5);
assert.equal(S.make(10, 12).roles.body.size, 9.5);
assert.equal(S.make(10, 12).roles.body.weight, 500);
assert.equal(S.make(10, 12, "en").roles.body.size, 10.25);
assert.equal(S.make(10, 12, "en").roles.body.weight, 400);
for (const [unit, expected] of [
  [{role:"table_label",fontFamily:"sans",matched:true,size:8},["sans",500]],
  [{role:"table_label",fontFamily:"serif",matched:true,size:8},["serif",500]],
  [{role:"figure_label",fontFamily:"sans",matched:true,size:6},["sans",500]],
  [{role:"figure_label",fontFamily:"sans",matched:true,size:5},["sans",400]],
  [{role:"figure_label",size:8,inkMask:[0,0,5,10]},["sans",400]],
  [{role:"figure_label",size:8,labelBold:true},["sans",700]]
]) {
  const face=S.labelFace(unit,"zh");
  assert.deepEqual([face.family,face.weight],expected);
}
assert.equal(S.make(10, 15).roles.body.step, 15);
assert.equal(S.sourceFamily("NUMK+NimbusSanL-Bold"), "sans");
assert.equal(S.sourceFamily("NUMK+Helvetica-Bold"), "sans");
assert.equal(S.sourceFamily("ABCDEF+CMR10"), "serif");
assert.equal(S.styleFor({typeRole:"documentTitle",fontFamily:"serif"},profile).family,"serif");
assert.equal(S.styleFor({typeRole:"body",fontFamily:"sans"},profile).family,"serif");
assert.equal(S.make(10, 12).roles.list.step, S.make(10, 12).roles.body.step);

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
assert.equal(role("Physical parameters", { role: "caption", captionKind: "table" }), "tableCaption");
assert.equal(role("A further note.", { role: "caption", captionKind: "footnote" }), "footnote");
assert.equal(role("An author, a paper and a journal.", { owner: 4 }), "reference");
assert.equal(role("Average", { role: "table_label", verifiedLabel: true }), null);
assert.equal(role("Experimental design", { layoutPart: "contents" }), "contents");

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
assert.equal(S.make(10, 12).roles.body.step, 14);
assert.equal(S.make(10, 12).roles.list.step, S.make(10, 12).roles.body.step);

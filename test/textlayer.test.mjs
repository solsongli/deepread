// Tests for DeepRead.TextLayerParser (built-in text-layer parser). Run: node test/textlayer.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ DeepRead: {}, console, Zotero: { debug() {} } });
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/textLayerParser.js"), "utf8"), ctx);
const TL = ctx.DeepRead.TextLayerParser;
const build = (pages) => JSON.parse(JSON.stringify(TL.buildContentList(pages)));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack || e}`); }
}

// ---- synthetic helpers: a line of text → chars --------------------------------------------------
function lineChars(text, { x = 72, top = 100, size = 10, font = "AAAAAA+Times-Roman", rotation = 0, para = true, H = 792 } = {}) {
  const y2 = H - top, y1 = y2 - size;
  const out = [];
  [...text].forEach((ch, i) => {
    const last = i === text.length - 1;
    out.push({
      c: ch, u: ch, rect: [x + i * size * 0.5, y1, x + (i + 1) * size * 0.5, y2], fontSize: size, fontName: font,
      baseline: y1 + size * 0.2, rotation, spaceAfter: ch === " " ? false : false,
      lineBreakAfter: last, paragraphBreakAfter: last && para,
    });
  });
  return out;
}
const page = (pageIndex, lines) => ({ pageIndex, viewBox: [0, 0, 612, 792], chars: lines.flat() });
const body = (t, top, extra = {}) => lineChars(t, { top, ...extra });
const longText = "The quick brown fox jumps over the lazy dog and keeps running through the forest ";

check("a numeric grid above its caption cannot absorb the following prose on cache reload", () => {
  const gridRow = (label, top) => {
    const chars = lineChars(label+" 82.3 91.2", {top, size:9});
    for (const [i,c] of chars.entries()) {
      const shift = (i > label.length ? 28 : 0) + (i > label.length+5 ? 16 : 0);
      c.rect[0] += shift;
      c.rect[2] += shift;
    }
    return chars;
  };
  const pg = page(6,[gridRow("Human",80),gridRow("System",94),
    body("Table 4: Accuracies on the development and test sets.",118),
    body("We predict a non-null answer when the score exceeds the threshold.",158,{para:false}),
    body("The threshold is selected on the development set.",171)]);
  const fresh = build([pg]), table = fresh.find(it=>it.type==="table");
  const prose = fresh.find(it=>it.text?.includes("non-null"));
  assert.ok(prose && table.bbox[3] < prose.bbox[1]);
  const old = {...table,id:8,bbox:[table.bbox[0],145,prose.bbox[2],prose.bbox[3]]};
  const repaired = TL.restoreCachedParagraphs([old],{index:6,view:pg.viewBox,chars:pg.chars});
  assert.equal(repaired.filter(it=>it.text?.includes("non-null")).length,1);
  assert.deepEqual(Array.from(repaired.find(it=>it.id===8).bbox),table.bbox);
});

check("a Roman table caption can immediately follow a figure caption in the same PDF block", () => {
  const fig = "Fig. 4: Attention remains concentrated on the selected targets.";
  const tab = "TABLE IV: Success rates across observation variants.";
  const pg = page(6, [body(fig,350,{para:false}), body(tab,362), body(longText,400)]);
  const parsed = build([pg]);
  assert.equal(parsed.find(it=>it.type==="image")?.image_caption[0],fig);
  assert.equal(parsed.find(it=>it.type==="table")?.table_caption[0],tab);
  const old = {type:"image",id:21,page_idx:6,bbox:[100,200,750,515],image_caption:[fig+" "+tab]};
  const repaired = TL.restoreCachedParagraphs([old],{index:6,view:pg.viewBox,chars:pg.chars});
  assert.equal(repaired.filter(it=>it.image_caption?.[0]===fig).length,1);
  assert.equal(repaired.filter(it=>it.table_caption?.[0]===tab).length,1);
});

check("de-hyphenation across line break", () => {
  const p = page(0, [
    body(longText + "inter-", 200, { para: false }),
    body("national agreements. " + longText, 212),
    body(longText + longText, 300),
  ]);
  const r = build([p]);
  assert.ok(r.some((i) => i.text && i.text.includes("international agreements")), JSON.stringify(r.map((i) => i.text)));
});

check("rotated chars (arXiv stamp) are dropped", () => {
  const p = page(0, [
    body(longText + longText, 200),
    lineChars("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", { x: 20, top: 200, rotation: 90 }),
  ]);
  const r = build([p]);
  assert.equal(r.filter((i) => /arXiv/.test(i.text || "")).length, 0);
  assert.equal(r.length, 1);
});

check("repeated header/footer and page numbers dropped", () => {
  const pages = [0, 1, 2, 3].map((i) => page(i, [
    body("Journal of Testing Vol. " + (10 + i), 30),
    body(longText + longText + i, 300),
    body(String(i + 1), 760),
  ]));
  const r = build(pages);
  assert.equal(r.length, 4, JSON.stringify(r.map((x) => x.text)));
  assert.ok(r.every((i) => !/Journal|^\d+$/.test(i.text)));
});

check("caption detection → image/table items", () => {
  const p = page(0, [
    body(longText + longText, 100, { para: true }),
    body(longText + longText, 112),
    body("Figure 3: A nice diagram of the system.", 400),
    body("Table 2: Results of the experiment.", 450),
    body(longText + longText, 600),
    body(longText + longText, 612),
  ]);
  const r = build([p]);
  const img = r.find((i) => i.type === "image");
  const tab = r.find((i) => i.type === "table");
  assert.ok(img && img.image_caption[0].startsWith("Figure 3"));
  assert.ok(tab && tab.table_caption[0].startsWith("Table 2"));
  assert.ok(img.bbox[1] < 400 / 792 * 1000, "figure region extends above its caption");
});

check("a first-page figure leaves the paper title and affiliation outside its frame", () => {
  const title = "A Scalable Method for Visual Learning";
  const p = page(0, [
    body(title, 95, { size: 16, x: 150 }),
    body("Alice Smith and Bob Jones", 122, { x: 225 }),
    body("Research Laboratory", 141, { x: 255 }),
    body("Abstract", 171, { x: 150, font: "AAAAAA+Times-Bold" }),
    body("Ours", 218, { x: 376, size: 8 }),
    body("Figure 1: Overview of the method.", 300, { x: 310, size: 9 }),
    body(longText + "success.", 331),
    body(longText + "quality.", 343),
  ]);
  const out = build([p]);
  assert.equal(out[0].text, title);
  assert.equal(out[0].text_level, 1);
  assert.ok(out.some(item => item.text?.includes("Research Laboratory")));
  assert.ok(out.find(item => item.type === "image").bbox[1] > 141 / 792 * 1000);
});

check("heading by font size and by numbering+bold", () => {
  const p = page(0, [
    body(longText + longText, 100), body(longText + longText, 112),
    body("2 Related Work", 160, { size: 12, font: "BBBBBB+Times-Bold" }),
    body(longText + longText, 190), body(longText + longText, 202),
    body("2.1 Small Things", 250, { font: "BBBBBB+Times-Bold" }),
    body(longText + longText, 280), body(longText + longText, 292),
  ]);
  const r = build([p]);
  const heads = r.filter((i) => i.text_level === 1).map((i) => i.text);
  assert.deepEqual(heads, ["2 Related Work", "2.1 Small Things"]);
});

check("differently typeset abstracts and stacked captions bound their own figures", () => {
  const abstract = {font:"BBBBBB+Helvetica",size:9,para:false};
  const p = page(0, [
    body("Abstract",92,{font:"BBBBBB+Helvetica-Bold"}),
    body(longText+"here.",108,abstract),
    body("Our second experiment repeats the first study and provides more evidence.",119,abstract),
    body("These independent measurements agree across all methods and datasets.",130,{...abstract,para:true}),
    body("Figure 1: The first architecture.",273),
    body("Figure 2: Evaluations of the model.",412),
    ...[500,512,524,536,548].map(y=>body(longText+longText,y))
  ]);
  const items=build([p]);
  const abstr=items.find(i=>i.text?.includes("independent measurements"));
  const [f1,f2]=items.filter(i=>i.type==="image");
  assert.ok(abstr && f1.bbox[1]>abstr.bbox[3] && f2.bbox[1]>=f1.bbox[3]);
  const old=items.filter(it=>it!==abstr).map(it=>it===f1?{...it,id:"old-figure",bbox:[0,120,900,360]}:it);
  const recovered=TL.restoreCachedParagraphs(old,{index:0,view:p.viewBox,chars:p.chars});
  assert.ok(recovered.some(it=>it.text===abstr.text));
  assert.deepEqual(Array.from(recovered.find(it=>it.id==="old-figure").bbox),f1.bbox);
});

check("a regular body sentence can start on the same line as a bold run-in heading", () => {
  const first=body("Models Complete Many Tasks. The",170,{font:"AAAA+Times-Bold"});
  for (const c of first.slice(-3)) c.fontName="AAAA+Times-Roman";
  const p=page(4,[first,body("model succeeds on most cloth folding tasks.",182)]);
  const [item,...rest]=build([p]);
  assert.equal(rest.length,0);
  assert.equal(item.text,"Models Complete Many Tasks. The model succeeds on most cloth folding tasks.");
  assert.equal(item.text_level,undefined);
  const before=[{id:7,type:"text",text_level:2,text:"Models Complete Many Tasks. The"},
    {id:8,type:"text",text:"model succeeds on most cloth folding tasks."}];
  const [cached]=TL.restoreCachedParagraphs(before,{index:4,view:p.viewBox,chars:p.chars});
  assert.equal(cached.text,item.text);
  assert.equal(cached.id,7);
});

check("a hanging continuation of an italic numbered heading belongs to that heading", () => {
  const face={font:"ABCDEF+NimbusSanL-ReguItal",size:12};
  const p=page(3,[body("3.4 Accelerating Inference for Real-time",110,face),
    body("Control",125,{...face,x:96}),body("We use diffusion to control the robot. "+longText,148),
    body("3.5 Experiments",240,face)]);
  const next=build([p]);
  const full=next.find(it=>it.text?.startsWith("3.4"));
  assert.equal(full.text,"3.4 Accelerating Inference for Real-time Control");
  assert.ok(full.text_level && next.some(it=>it.text==="3.5 Experiments"));
  const old=[{...full,id:8,text:"3.4 Accelerating Inference for Real-time"},{...full,id:9,text:"Control"}];
  const repaired=TL.restoreCachedParagraphs(old,{index:3,view:p.viewBox,chars:p.chars});
  assert.equal(repaired.length,1);
  assert.equal(repaired[0].id,8);
  assert.equal(repaired[0].text,full.text);
});

check("a numbered section stays separate from a following paragraph's bold lead-in", () => {
  for (const [title,size] of [["4.3 Generalization",12],["B.1 Test-Set Construction",10]]) {
    const bold="ABCDEF+NimbusSanL-Bold";
    const lead="Source and Split.";
    const first=body(lead+" These tasks were verified using an independent test set.",130);
    for (const c of first.slice(0,lead.length)) c.fontName=bold;
    const p=page(11,[body(title,114,{font:bold,size}),first,body(longText,270)]);
    const fresh=build([p]);
    assert.ok(fresh[0].text_level && fresh[0].text===title);
    assert.ok(!fresh[1].text_level && fresh[1].text.startsWith(lead));
    const combined={id:9,type:"text",text:title+" "+fresh[1].text,bbox:[0,0,1000,1000]};
    const corrected=TL.restoreCachedParagraphs([combined],{index:11,view:p.viewBox,chars:p.chars});
    assert.deepEqual(Array.from(corrected,it=>[it.text,it.text_level]),fresh.slice(0,2).map(it=>[it.text,it.text_level]));
    assert.equal(corrected[0].id,9);
  }
});

check("cached title and byline split only when the authors and affiliations remain complete", () => {
  const title="A Benchmark for Robot Learning";
  const p=page(0,[body(title,80,{size:16,font:"AAAA+Times-Bold"}),
    body("Alice Smith and Bob Chen",113,{size:11}),body("Example Institute",130,{size:9}),
    body("Abstract",170,{font:"AAAA+Times-Bold"}),body(longText+longText,190)]);
  const fresh=build([p]), authors=fresh[1].text;
  assert.ok(authors.includes("Bob Chen") && authors.includes("Example Institute"));
  const old=[{...fresh[0],id:"title",text:title+" Alice Smith",bbox:[0,0,1000,200]},
    {...fresh[1],id:"authors",text:authors.replace(/^Alice Smith\s*/u,"")}];
  const restore=items=>TL.restoreCachedParagraphs(items,{index:0,view:p.viewBox,chars:p.chars});
  const repaired=restore(old);
  assert.deepEqual(Array.from(repaired,it=>[it.id,it.text]),[["title",title],["authors",authors]]);
  const incomplete=[old[0],{...old[1],text:"and Bob Chen"}];
  assert.equal(restore(incomplete)[0].text,old[0].text);
});

check("bold italic terms inside a bold abstract retain their paragraph", () => {
  const names=["Abstract—We introduce", "Grounded Action Models", "(GAMs), a method for robotics."];
  const p=page(0,names.map((text,i)=>body(text,150+11*i,{size:9,para:i===2,
    font:i===1?"ABCDEF+NimbusRomNo9L-MediItal":"ABCDEF+NimbusRomNo9L-Medi"})));
  const expected=names.join(" ");
  assert.equal(build([p]).find(it=>it.text.startsWith("Abstract"))?.text,expected);
  const old=names.map((text,i)=>({type:"text",text,id:i}));
  const restored=TL.restoreCachedParagraphs(old,{index:0,view:p.viewBox,chars:p.chars});
  assert.equal(restored.length,1);
  assert.equal(restored[0].text,expected);
});

check("markdown output", () => {
  const md = TL.toMarkdown([{ type: "text", text: "T", text_level: 1 }, { type: "text", text: "p" },
    { type: "image", image_caption: ["Figure 1: x."] }, { type: "equation", text: "a=b" }]);
  assert.equal(md, "# T\n\np\n\n*Figure 1: x.*\n\n$$a=b$$\n");
});

// ---- demo paper vs MinerU -----------------------------------------------------------------------
const charsPath = path.join(root, "test/fixtures/demo/chars.json");
const refPath = path.join(root, "test/fixtures/demo/demo_content_list.json");
if (fs.existsSync(charsPath) && fs.existsSync(refPath)) {
  const pages = JSON.parse(fs.readFileSync(charsPath, "utf8"));
  const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
  const t0 = Date.now();
  const out = build(pages);
  const ms = Date.now() - t0;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  const refHeads = ref.filter((i) => i.text_level === 1);
  const outHeads = out.filter((i) => i.text_level === 1).map((i) => norm(i.text));
  const foundHeads = refHeads.filter((r) => outHeads.some((h) => h.startsWith(norm(r.text).slice(0, 20)))).length;
  const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const refText = ref.filter((i) => i.type === "text" && i.page_idx < 9);
  const covered = refText.filter((r) => {
    const a = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]);
    return out.some((o) => o.page_idx === r.page_idx && ov(o.bbox, r.bbox) > 0.3 * a);
  }).length;
  const cnt = (l, t) => l.filter((i) => i.type === t).length;
  console.log(`metrics: items=${out.length} ms=${ms} headings=${foundHeads}/${refHeads.length} (out ${outHeads.length}) ` +
    `coverage=${covered}/${refText.length} image=${cnt(out, "image")}/${cnt(ref, "image")} table=${cnt(out, "table")}/${cnt(ref, "table")}`);

  check("demo: headings recall >= 85%", () => assert.ok(foundHeads / refHeads.length >= 0.85));
  check("demo: paper title found as heading", () => assert.ok(out.some((i) => i.text_level === 1 && i.page_idx === 0 && /Attention Is All You Need/.test(i.text))));
  check("demo: no arXiv stamp item", () => assert.ok(!out.some((i) => /^arXiv:/.test(i.text || ""))));
  check("demo: no page-number-only items", () => assert.ok(!out.some((i) => i.type === "text" && /^\s*\d{1,3}\s*$/.test(i.text))));
  check("demo: author names are not headings", () => assert.ok(!out.some((i) => i.text_level === 1 && i.page_idx === 0 && /Vaswani|Shazeer|Parmar/.test(i.text))));
  check("demo: page 0 front matter merged, notice dropped", () => {
    const p0 = out.filter((i) => i.page_idx === 0);
    assert.equal(p0[0].text_level, 1);
    assert.ok(!p0.some((i) => /grants permission/.test(i.text)));
    const authors = p0.filter((i) => /Vaswani/.test(i.text));
    assert.equal(authors.length, 1);
    assert.ok(/Shazeer/.test(authors[0].text) && / · /.test(authors[0].text));
    assert.ok(p0.findIndex((i) => /^Abstract/.test(i.text)) === p0.indexOf(authors[0]) + 1);
  });
  check("demo: table content not a heading", () => assert.ok(!out.some((i) => i.text_level === 1 && /Parser Training/.test(i.text))));
  check("demo: 3.5 and 6.2 headings found", () => {
    assert.ok(out.some((i) => i.text_level === 1 && /^3\.5 Positional/.test(i.text)));
    assert.ok(out.some((i) => i.text_level === 1 && /^6\.2 Model Variations/.test(i.text)));
  });
  check("demo: >= 70% of MinerU text blocks (pages 1-9) covered", () => assert.ok(covered / refText.length >= 0.7));
  check("demo: figures and tables captioned", () => {
    assert.ok(cnt(out, "image") >= 4 && cnt(out, "table") >= 3);
    assert.ok(out.some((i) => i.type === "image" && /^Figure 1/.test(i.image_caption[0])));
  });
  check("demo: bboxes valid and ordered by page", () => {
    let last = 0;
    for (const i of out) {
      assert.ok(i.bbox.length === 4 && i.bbox.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000));
      assert.ok(i.bbox[2] >= i.bbox[0] && i.bbox[3] >= i.bbox[1]);
      assert.ok(i.page_idx >= last);
      last = i.page_idx;
    }
  });
}
else console.log("SKIP demo comparison (test/fixtures/demo/chars.json missing; run scripts/e2e.sh test/e2e/dump-chars.js)");

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");

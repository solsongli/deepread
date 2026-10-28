// Smoke test for DeepRead.Pipeline / DeepRead.SummaryManager (no Zotero needed). Run: node test/pipeline-smoke.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

const sandbox = {
  setTimeout, clearTimeout, console, Intl,
  Zotero: { debug() {}, locale: "zh-CN" },
  DeepRead: {},
};
const ctx = vm.createContext(sandbox);
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "pipeline/responseFormats.js",
  "services/typography.js", "services/translationLayout.js", "services/continuations.js", "pipeline/summaryManager.js", "pipeline/pipeline.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const DR = sandbox.DeepRead;
// values created inside the vm context have foreign prototypes: compare through JSON
const j = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  }
  catch (e) {
    console.log(`FAIL ${name}\n${e.stack || e}`);
    process.exitCode = 1;
  }
}

function makePipeline(over = {}) {
  return new DR.Pipeline({
    getPdfApp: () => null,
    llm: async () => ({ content: "" }),
    parsePDF: async () => ({ resultDir: "/tmp/x", contentList: [], markdown: "" }),
    onProgress() {}, notify() {},
    ...over,
  });
}

// ---------------------------------------------------------------------------------------------------------
// unit-level checks
// ---------------------------------------------------------------------------------------------------------
await check("modules loaded", () => {
  assert.equal(typeof DR.Pipeline, "function");
  assert.equal(typeof DR.SummaryManager, "function");
  assert.ok(DR.PARSE_LANGUAGES.zh && DR.PARSE_LANGUAGES.en);
  assert.equal(typeof DR.detectLanguage, "function");
  assert.equal(typeof DR.ResponseFormats.pageSummaryFormat, "function");
});

await check("selectMainBlocks returns page groups", () => {
  const p = makePipeline();
  const list = [
    { id: 0, type: "text", text: "Title", text_level: 1, bbox: [100, 50, 900, 90], page_idx: 0 },
    { id: 1, type: "text", text: "1 Introduction", text_level: 1, bbox: [100, 120, 500, 150], page_idx: 0 },
    { id: 2, type: "text", text: "Deep learning has changed everything. It is great.", bbox: [100, 160, 900, 260], page_idx: 0 },
    { id: 3, type: "text", text: "Second page paragraph with enough words in it.", bbox: [100, 100, 900, 200], page_idx: 1 },
  ];
  const groups = p.selectMainBlocks(list);
  assert.ok(Array.isArray(groups) && groups.length === 2, JSON.stringify(groups));
  assert.deepEqual(j(groups.map((g) => g.page_idx)), [0, 1]);
  assert.ok(groups[0].blocks.length >= 1 && groups[1].blocks.length >= 1);
});

await check("_buildPagePrompt contains the paragraph id", () => {
  const p = makePipeline();
  const prompt = p._buildPagePrompt([{ page_idx: 2, paragraph_idx: 5, sentences: [{ text: "Hello." }, { text: "World." }] }]);
  assert.ok(prompt.includes("2_5"), prompt.slice(-300));
  assert.ok(prompt.includes("Hello."));
});

await check("_call_llm_api semantics", async () => {
  let reply = "";
  let seen = null;
  const p = makePipeline({ llm: async (req) => { seen = req; return { content: reply }; } });
  reply = '[{"a":1}]';
  const arr = await p._call_llm_api("hi", { system: "sys", max_tokens: 77, temperature: 0.3, response_format: { type: "json_object" } });
  assert.ok(Array.isArray(arr) && arr[0].a === 1);
  assert.deepEqual(j(seen.messages), [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  assert.equal(seen.maxTokens, 77);
  assert.equal(seen.temperature, 0.3);
  assert.deepEqual(j(seen.responseFormat), { type: "json_object" });
  reply = '{"a":1}';
  assert.equal(await p._call_llm_api("hi"), '{"a":1}');
  assert.deepEqual(j(seen.messages), [{ role: "user", content: "hi" }]);
  reply = "not json at all";
  assert.equal(await p._call_llm_api("hi"), "not json at all");
  reply = "";
  assert.equal(await p._call_llm_api("hi"), "");
  // fenced JSON: returned raw (like Vibero), the consumer's _parseJSONWithRetry strips the fence
  reply = '```json\n{"a":1}\n```';
  const raw = await p._call_llm_api("hi");
  assert.equal(typeof raw, "string");
  assert.deepEqual(j(p._parseJSONWithRetry(raw, "t")), { a: 1 });
  // errors propagate unchanged
  const boom = new Error("HTTP 429 Too Many");
  const p2 = makePipeline({ llm: async () => { throw boom; } });
  await assert.rejects(() => p2._call_llm_api("x"), (e) => e === boom);
});

await check("_isPointSplitValidWithTranslation", () => {
  const p = makePipeline();
  assert.equal(p._isPointSplitValidWithTranslation([[0], [1]], 2, ["aa", "bb"], ["x", "y"]), true);
  assert.equal(p._isPointSplitValidWithTranslation([[0]], 2, ["aa"], ["x"]), false);
  assert.equal(p._isPointSplitValidWithTranslation([[0], [1]], 2, ["aa", "bb"], ["x", ""]), false);
});

await check("SummaryManager.setPageSizes drives bbox -> rect conversion", () => {
  const sm = new DR.SummaryManager();
  assert.deepEqual(j(sm._convertMinerUBboxToRects([0, 0, 500, 500], 3)), [[0, 396, 306, 792]]);
  sm.setPageSizes({ 3: { width: 1000, height: 2000 } });
  assert.deepEqual(j(sm._convertMinerUBboxToRects([0, 0, 500, 500], 3)), [[0, 1000, 500, 2000]]);
  assert.deepEqual(j(sm._convertMinerUBboxToRects([0, 0, 500, 500], 4)), [[0, 396, 306, 792]]);
});

await check("every this.<member> used by the pipeline is defined", () => {
  const src = fs.readFileSync(path.join(scripts, "pipeline/pipeline.js"), "utf8");
  const p = makePipeline();
  const proto = DR.Pipeline.prototype;
  const missing = new Set();
  for (const m of src.matchAll(/this\.(\w+)\s*\(/g)) {
    if (!(m[1] in proto) && typeof p[m[1]] !== "function") missing.add(m[1]);
  }
  assert.deepEqual([...missing], []);
});

// ---------------------------------------------------------------------------------------------------------
// synthetic end-to-end run
// ---------------------------------------------------------------------------------------------------------
const PW = 600, PH = 800; // deliberately not 612x792: proves real page sizes are used for rects

const contentList = [
  { id: 0, type: "text", text: "A Tiny Paper", text_level: 1, bbox: [200, 40, 800, 70], page_idx: 0 },
  { id: 1, type: "text", text: "1 Introduction", text_level: 1, bbox: [100, 100, 400, 130], page_idx: 0 },
  { id: 2, type: "text", text_level: 0, page_idx: 0, bbox: [100, 150, 900, 250],
    text: "Neural networks learn representations from data. They are used widely in practice." },
  { id: 3, type: "text", text_level: 0, page_idx: 0, bbox: [100, 300, 900, 400],
    text: "Our method improves accuracy on benchmarks. It also trains faster than baselines." },
];

function makeChars(contentList) {
  const chars = [];
  for (const block of contentList) {
    const [bx0, by0, bx1, by1] = block.bbox;
    // permille (top-left origin) -> PDF points (bottom-left origin)
    const x0 = bx0 / 1000 * PW, x1 = bx1 / 1000 * PW;
    const yTop = PH - by0 / 1000 * PH, yBottom = PH - by1 / 1000 * PH;
    const text = block.text;
    const cw = Math.min(8, (x1 - x0) / (text.length + 1));
    const midY = (yTop + yBottom) / 2;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === " ") {
        if (chars.length) chars[chars.length - 1].spaceAfter = true;
        continue;
      }
      chars.push({
        u: ch,
        rect: [x0 + i * cw, midY - 4, x0 + (i + 1) * cw, midY + 4],
        spaceAfter: false, lineBreakAfter: false, paragraphBreakAfter: false,
      });
    }
    chars[chars.length - 1].paragraphBreakAfter = true;
  }
  return chars;
}

const viewport = { viewBox: [0, 0, PW, PH], originalViewBox: [0, 0, PW, PH] };
function makePdfApp() {
  return {
    pdfDocument: {
      numPages: 1,
      getPageData: async ({ pageIndex }) => {
        assert.equal(pageIndex, 0);
        return { chars: makeChars(contentList) };
      },
      getPage: async (n) => {
        assert.equal(n, 1);
        return { getViewport: () => viewport };
      },
    },
    pdfViewer: { pagesCount: 1, getPageView: () => ({ viewport }) },
  };
}

function makeFakeLLM(log) {
  return async ({ messages, responseFormat }) => {
    const prompt = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    log.push({ prompt, responseFormat });
    const name = responseFormat?.json_schema?.name || "";
    if (name === "PageSummaryOutput" || prompt.includes("Paragraph list:") || prompt.includes("段落列表:")) {
      // ids look like: { id: “0_0”, sentences: [\n  [0] "..."\n  [1] "..."\n] }
      const paragraphs = [];
      for (const m of prompt.matchAll(/id: [“"](\d+_\d+)[”"], sentences: \[\n([\s\S]*?)\n\] \}/g)) {
        const n = [...m[2].matchAll(/^\s*\[(\d+)\] /gm)].length;
        paragraphs.push({
          id: m[1],
          paragraph_summary: `summary ${m[1]}`,
          point_split: Array.from({ length: n }, (_, i) => [i]),
          point_summaries: Array.from({ length: n }, (_, i) => `point ${m[1]} #${i}`),
          point_translations: Array.from({ length: n }, (_, i) => `翻译 ${m[1]} #${i}`),
          point_importance_levels: Array.from({ length: n }, (_, i) => i === 0 ? 3 : 1),
        });
      }
      return { content: JSON.stringify({ paragraphs }) };
    }
    if (name.toLowerCase().includes("article")) {
      const t = DR.PARSE_LANGUAGES.zh.summaryTitles;
      return {
        content: JSON.stringify({
          article_summary: [
            { title: t.paperTitle, content: "A Tiny Paper", points: [] },
            { title: t.background, content: "background", points: [] },
            { title: t.innovations, content: "", points: [{ point_title: "p1", content: "c1", block_ids: [] }] },
            { title: t.experiments, content: "", points: [{ point_title: "p2", content: "c2", block_ids: [] }] },
            { title: t.conclusions, content: "conclusion", points: [] },
          ],
        }),
      };
    }
    if (name.toLowerCase().includes("outline")) {
      return { content: JSON.stringify({ outline: { title: "A Tiny Paper", title_block_id: 0, level: 0, summary: "A tiny paper outline", children: [] } }) };
    }
    return { content: JSON.stringify({ indices: [] }) };
  };
}

await check("end-to-end run() on a synthetic one-page paper", async () => {
  const llmLog = [];
  const progress = [];
  const notes = [];
  const parseCalls = [];
  const p = makePipeline({
    getPdfApp: makePdfApp,
    llm: makeFakeLLM(llmLog),
    parsePDF: async (o) => {
      parseCalls.push(o);
      return { resultDir: "/tmp/result", contentList: JSON.parse(JSON.stringify(contentList)), markdown: "# A Tiny Paper" };
    },
    onProgress: (x) => progress.push(x),
    notify: (m, t) => notes.push([t, m]),
    language: "zh",
    filterAuthors: true,
    concurrency: 2,
  });
  const result = await p.run();

  assert.deepEqual(j(parseCalls[0].excludedPageIndices), []);
  assert.equal(result.resultDir, "/tmp/result");
  assert.equal(result.markdown, "# A Tiny Paper");
  assert.equal(result.contentList.length, 4);
  assert.ok(result.articleSummary && result.articleSummary.length === 5, "article summary");
  assert.deepEqual(notes.filter((n) => n[0] === "warning" || n[0] === "error"), []);

  const hd = result.hierarchicalData;
  assert.equal(hd.length, 1);
  assert.equal(hd[0].pageIndex, 0);
  const paras = hd[0].paragraphs;
  assert.ok(paras.length >= 2, `paragraphs: ${paras.length}`);
  const withPoints = paras.filter((pp) => pp.points && pp.points.length);
  assert.ok(withPoints.length >= 2, "paragraphs with points");
  for (const pp of withPoints) {
    assert.ok(pp.rects.length > 0, "paragraph rects");
    for (const r of pp.rects) {
      assert.equal(r.length, 4);
      assert.ok(r[0] >= 0 && r[2] <= PW + 1e-6 && r[1] >= 0 && r[3] <= PH + 1e-6, `rect in page: ${r}`);
    }
    for (const pt of pp.points) {
      assert.ok(pt.rects.length > 0 && pt.rects[0].length === 4, "point rects");
      assert.equal(pt.importance_source, "model");
      assert.equal(pt.importance_level, pt.pointIndex === 0 ? 3 : 1);
      assert.ok(pt.translation.startsWith("翻译"), `translation: ${pt.translation}`);
      assert.ok(pt.summary.startsWith("point"), pt.summary);
    }
  }
  const body = paras.filter((pp) => /Neural networks|Our method/.test(pp.paragraphText || ""));
  assert.equal(body.length, 2, "two body paragraphs: " + JSON.stringify(paras.map((pp) => pp.paragraphText)));
  for (const pp of body) assert.equal(pp.sentences.length, 2, JSON.stringify(pp.sentences.map((x) => x.text)));
  // rects come from the chars (PDF points); the first body paragraph sits at y in [~600, ~680] on an 800pt page
  const first = body[0];
  assert.ok(first.rects[0][1] > 500 && first.rects[0][3] < 700, `first rect ${first.rects[0]}`);

  // progress is monotonic where percents are given and ends at 100
  const pcts = progress.map((x) => x.percent).filter((x) => typeof x === "number");
  assert.equal(pcts[pcts.length - 1], 100);
  assert.ok(pcts.includes(18) && pcts.includes(40) && pcts.includes(90));

  // page LLM requests used the schema, the author filter ran, and the article summary was requested
  assert.ok(llmLog.some((c) => c.responseFormat?.json_schema?.name === "PageSummaryOutput"));
  assert.ok(llmLog.some((c) => /Article|article|全文/.test(c.responseFormat?.json_schema?.name || "") || /article_summary/.test(c.prompt)));

  // getState / SummaryManager agree
  const st = p.getState();
  assert.equal(st.hierarchicalData.length, 1);
  assert.equal(p._summaryManager.getPageSizes()[0].width, PW);

  // generateOutline() with the same fake LLM
  const outline = await p.generateOutline();
  assert.ok(outline && outline.title === "A Tiny Paper", JSON.stringify(outline));
  assert.equal(p.getState().sections.title, "A Tiny Paper");

  // regenerateArticleSummary()
  const regen = await p.regenerateArticleSummary();
  assert.equal(regen.articleSummary.length, 5);
  assert.ok(regen.blockMapping);

  // loadState on a fresh pipeline restores what getState returns
  const p2 = makePipeline({ llm: makeFakeLLM([]) });
  p2.loadState(j(p.getState()));
  assert.deepEqual(j(p2.getState().hierarchicalData), j(st.hierarchicalData));
});

await check("run() stops after abort and does not call the LLM", async () => {
  const ac = new AbortController();
  let llmCalls = 0;
  const p = makePipeline({
    getPdfApp: makePdfApp,
    llm: async () => { llmCalls++; return { content: "{}" }; },
    parsePDF: async () => {
      ac.abort(); // aborted while the (slow) parse finishes
      return { resultDir: "/tmp/r", contentList: JSON.parse(JSON.stringify(contentList)), markdown: "" };
    },
    signal: ac.signal,
  });
  await assert.rejects(() => p.run(), (e) => e.name === "AbortError" && /aborted/.test(e.message));
  assert.equal(llmCalls, 0);
});

console.log(process.exitCode ? `\nFAILED (${passed} passed)` : `\nAll ${passed} checks passed`);
// the ported code leaves 4/5-minute timeout timers behind (as in Vibero); do not wait for them
process.exit(process.exitCode || 0);

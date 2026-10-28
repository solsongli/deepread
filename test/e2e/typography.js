/* Offline renderer regression using real PDF.js chars and MinerU-shaped blocks.
 * python3 test/build-reading-fixture.py
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/typography.pdf scripts/e2e.sh test/e2e/typography.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  for (let i = 0; i < 100 && !Zotero.DeepRead; i++) await sleep(100);
  const D = Zotero.DeepRead;
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = D.Session.forReader(reader);
  await session.init();
  const app = session.pdfAdapter();
  await app.prepareGeometry();
  const data = await app.pdfDocument.getPageData({ pageIndex: 0 });
  const chars = data.chars.map((c, offset) => ({ ...c, offset, pageIndex: 0 }));
  const bbox = (r) => [r[0] / 612 * 1000, (792 - r[3]) / 792 * 1000, r[2] / 612 * 1000, (792 - r[1]) / 792 * 1000];
  const contentList = [
    { id: 0, page_idx: 0, type: "text", text: "Important result. Ordinary explanation.", bbox: bbox([40, 280, 500, 710]) },
    { id: 1, page_idx: 0, type: "image", image_caption: ["Figure 1: Measured performance."], bbox: bbox([50, 350, 280, 580]) },
  ];
  const pipeline = new D.Pipeline({ getPdfApp: () => app });
  pipeline._summaryManager.setCharsDataList(chars);
  pipeline._summaryManager.setPageSizes([{ pageIndex: 0, width: 612, height: 792 }]);
  const blocks = pipeline.selectMainBlocks(contentList);
  const matched = pipeline.bboxMatch(blocks, [], chars);
  const paragraphs = pipeline.processSentenceData(matched);
  const prompt = pipeline._buildPagePrompt(paragraphs);
  E2E.result.steps.push({ name: "source-fonts", data: chars.slice(25, 35).map((c) => ({ u: c.u, fontName: c.fontName, fontSize: c.fontSize, bold: c.bold })) });
  assert(prompt.includes("**Important result.**"), "Actual PDF bold run missing from translation prompt");
  assert(!paragraphs[0].paragraph_text.includes("AXIS"), "Figure labels leaked into prose");
  paragraphs.forEach((p, i) => Object.assign(p, { paragraph_summary: "测试", point_split: [p.sentences.map((_, j) => j)], point_translations: [i === 0 ? "**重要结果。** 后面是普通解释。" : "**图 1：**测量结果。"], point_summaries: ["测试"] }));
  pipeline._summaryManager.buildHierarchicalData(paragraphs);
  const hierarchy = pipeline._summaryManager.hierarchicalData;
  session.data = { hierarchicalData: hierarchy, contentList };
  session.overlay.setData(hierarchy);
  session.structureBar.refresh();
  assert(!!session.structureBar.root.querySelector(".dr-figures"), "Figure reading control missing");
  const overlay = session.overlay;
  await sleep(700);
  const paras = overlay.pages.get(0);
  for (let i = 0; i < paras.length; i++) {
    await reader.navigate({ position: { pageIndex: 0, rects: paras[i].rects } });
    await sleep(400);
    overlay.trPara = paras[i];
    overlay._drawHover(paras[i]);
    await sleep(150);
    const box = overlay.pdfDoc.querySelector(".dr-translation");
    assert(box, "No translation rendered");
    assert(Number(box.dataset.scale) <= 1, "Translation enlarged beyond original");
    assert(box.querySelector("strong"), "Bold translation lost in renderer");
    assert(box.querySelector("strong").textContent !== box.textContent.trim(), "Entire translation was bolded");
    const font = Number(box.dataset.fontSize);
    const r = box.getBoundingClientRect();
    assert(font < 30, "Oversized caption font");
    if (i === 1) assert(r.height < 80, "Caption stretched to figure height");
    E2E.result.steps.push({ name: i ? "caption" : "body", data: { font, height: r.height, text: box.textContent } });
    const win = Zotero.getMainWindow();
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), `typography-${i}.png`), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  }
  return { checks: "Real PDF bold, MinerU bounds, caption metrics, mixed translation rendering, figure navigation" };
};

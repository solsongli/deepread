/* Real PDF geometry with local joint-translation replies; never calls a remote model.
 * python3 -E test/build-continuation-fixture.py
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/continuations.pdf scripts/e2e.sh test/e2e/continuations.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); Zotero.debug(`[E2E] ${name}: ${!!ok}`); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead; i++) await sleep(100);
  const D = Zotero.DeepRead;
  for (let i = 0; i < 100 && !D.Panes.paneIDs.chat; i++) await sleep(100);
  D.prefs.set("cards.autoExplain", false);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = D.Session.forReader(reader);
  await session.init();
  const app = session.pdfAdapter();
  await app.prepareGeometry();
  const chars = [];
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const data = await app.pdfDocument.getPageData({ pageIndex });
    for (const c of data.chars) chars.push({ ...c, offset: chars.length, pageIndex });
  }
  const bbox = (r) => [r[0] / 612 * 1000, (792 - r[3]) / 792 * 1000, r[2] / 612 * 1000, (792 - r[1]) / 792 * 1000];
  const contentList = [
    { id: 0, type: "text", text: "The network combines two feature representations to improve", page_idx: 0, bbox: bbox([45, 692, 560, 712]) },
    { id: 1, type: "image", image_caption: ["Figure 1: Separate caption."], page_idx: 0, bbox: bbox([50, 375, 550, 630]) },
    { id: 2, type: "text", text: "the accuracy of its predictions on unseen samples.", page_idx: 0, bbox: bbox([45, 342, 560, 362]) },
    { id: 3, type: "text", text: "2 Page boundary", text_level: 1, page_idx: 0, bbox: bbox([45, 232, 560, 256]) },
    { id: 4, type: "text", text: "The model minimizes a consistency objective while retaining", page_idx: 0, bbox: bbox([45, 162, 560, 182]) },
    { id: 5, type: "text", text: "the original features needed for downstream prediction.", page_idx: 1, bbox: bbox([45, 692, 560, 712]) },
    { id: 6, type: "text", text: "This independent paragraph discusses a different experiment.", page_idx: 1, bbox: bbox([45, 622, 560, 642]) },
  ];
  let calls = 0;
  const reply = async (args) => {
    calls++;
    const input = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
    check("request contains both ends and no caption", input.length === 2 && input.every((u) => u.parts.length === 2)
      && !JSON.stringify(input).includes("Separate caption"));
    check("joint translation receives source emphasis", input[0].parts[0].text.includes("**"));
    return { content: JSON.stringify({ groups: [
      { keys: ["p_0_0", "p_0_2"], translation: "**网络融合两种特征表示**，以提升对未见样本的预测准确率。" },
      { keys: ["p_0_4", "p_1_0"], translation: "模型在保留下游预测所需原始特征的同时，最小化一致性目标。" },
    ] }) };
  };
  const pipeline = new D.Pipeline({ getPdfApp: () => app, llm: reply });
  pipeline._summaryManager.setCharsDataList(chars);
  pipeline._summaryManager.setPageSizes({ 0: { width: 612, height: 792 }, 1: { width: 612, height: 792 } });
  const raw = pipeline.processSentenceData(pipeline.bboxMatch(pipeline.selectMainBlocks(contentList), [], chars));
  pipeline._generateSummaryAndTranslationByPage = async (parts) => parts.map((p) => ({ ...p, paragraph_summary: "原文片段",
    point_split: [p.sentences.map((_, i) => i)], point_summaries: ["片段要点"], point_translations: ["旧的分块译文"], point_importance_levels: [1] }));
  const translated = await pipeline.llmRequest(raw);
  check("one batched joint translation request", calls === 1);
  pipeline._summaryManager.buildHierarchicalData(translated);
  const hierarchicalData = D.Session.compactHierarchicalData(pipeline._summaryManager.hierarchicalData);
  session.data = { hierarchicalData, contentList };
  session._emit("change");
  session.overlay.setData(hierarchicalData);
  session.rail.refresh();
  await sleep(500);
  const overlay = session.overlay, rail = session.rail;
  check("cross-figure card is one group", session.groupLead("p_0_2") === "p_0_0");
  check("cross-page card is one group", session.groupLead("p_1_0") === "p_0_4");
  check("figure and independent paragraph remain separate", session.groupLead("p_0_1") === "p_0_1" && session.groupLead("p_1_1") === "p_1_1");
  check("source label excludes intervening caption", session.groupLabel("p_0_0").endsWith("¶1, 3"));
  const lookup = (page, index) => overlay.pages.get(page).find((p) => p.paragraphIndex === index);
  const first = lookup(0, 0), last = lookup(0, 2);
  check("one translated paragraph in the merged card", overlay.translationsFor([first, last]).length === 1);
  check("either end returns the same joint translation", overlay._paragraphTranslation(first) === overlay._paragraphTranslation(last)
    && overlay._paragraphTranslation(last).includes("未见样本"));
  await reader.navigate({ position: { pageIndex: 0, rects: last.rects } });
  await sleep(250);
  overlay.trPara = last; overlay.hoverPara = last;
  overlay._drawHover(last);
  const box = overlay.pdfDoc.querySelector(".dr-translation");
  check("hover shows joined text", box?.textContent.includes("网络融合") && box.textContent.includes("未见样本"));
  check("text height excludes the intervening picture", box.offsetHeight < 110);
  check("both source fragments are outlined separately", overlay.pdfDoc.querySelectorAll(".dr-outline").length === 2);
  check("joined source emphasis renders", !!box.querySelector("strong"));
  const win = Zotero.getMainWindow();
  win.resizeTo(1450, 1000);
  await reader.navigate({ pageIndex: 0 });
  await sleep(500);
  overlay._drawHover(last);
  const visibleBox = overlay.pdfDoc.querySelector(".dr-translation").getBoundingClientRect();
  const viewport = overlay.pdfDoc.getElementById("viewerContainer").getBoundingClientRect();
  check("joined popup stays inside the visible reading area", visibleBox.top >= viewport.top - 1 && visibleBox.bottom <= viewport.bottom + 1);
  const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "continuation-figure.png"), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  overlay._setHover(null);
  const follower = lookup(1, 0);
  await reader.navigate({ position: { pageIndex: 1, rects: follower.rects } });
  await sleep(350);
  overlay.openParagraph(follower);
  check("clicking page-two fragment opens shared card", rail.isOpen("p_0_4"));
  const anchor = rail._items().find((i) => i.key === "p_0_4");
  check("shared card follows the fragment being read", anchor.pageIndex === 1);
  overlay.trPara = follower; overlay.hoverPara = follower; overlay._drawHover(follower);
  check("page-two hover contains the full translated sentence", overlay.pdfDoc.querySelector(".dr-translation")?.textContent.includes("最小化一致性目标"));

  await D.Store.savePaper(session.key, session.item.id, { hierarchical_data: hierarchicalData });
  const stored = await D.Store.getPaper(session.key);
  check("joint translation and formatting survive persistence", stored.hierarchical_data[0].paragraphs[0].continuation.translation.includes("**")
    && stored.hierarchical_data[0].paragraphs[0].typography.fontSize === 10
    && stored.hierarchical_data[0].paragraphs[0].points[0].importance_source === "model");

  // Old cached results upgrade automatically without reparsing or generating questions.
  const legacy = hierarchicalData.map((page) => ({ ...page, paragraphs: page.paragraphs.map((p) => ({ ...p, continuation: null, continuationChecked: false })) }));
  session.data = { hierarchicalData: legacy, contentList }; session._cardGroups = null;
  session._questionsRequested = true; session._continuationsRequested = false;
  const savedComplete = D.LLM.complete, savedConfigured = D.LLM.isConfigured;
  D.LLM.complete = reply; D.LLM.isConfigured = () => true;
  try {
    session._autoGenerate();
    for (let i = 0; i < 100 && session._joiningContinuations; i++) await sleep(100);
    check("old cache joins automatically", calls === 2 && session.data.hierarchicalData[1].paragraphs[0].continuation?.lead === "p_0_4");
    session._autoGenerate();
    await sleep(100);
    check("checked results do not request again", calls === 2);
  }
  finally { D.LLM.complete = savedComplete; D.LLM.isConfigured = savedConfigured; }
  await sleep(500);
  return { checks: E2E.result.steps.length };
};

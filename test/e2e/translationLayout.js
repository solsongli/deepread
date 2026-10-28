/* Source structure, actual collapse visibility and role contrast in real Zotero.
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/paragraph-layout.pdf scripts/e2e.sh test/e2e/translationLayout.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); Zotero.debug(`[E2E] ${name}: ${!!ok}`); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead;
  D.prefs.set("cards.autoExplain", false);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const app = s.pdfAdapter(); await app.prepareGeometry();
  const chars = (await app.pdfDocument.getPageData({ pageIndex: 0 })).chars.map((c, offset) => ({ ...c, offset, pageIndex: 0 }));
  const bbox = (r) => [r[0] / 612 * 1000, (792 - r[3]) / 792 * 1000, r[2] / 612 * 1000, (792 - r[1]) / 792 * 1000];
  const listText = "• Closed-loop action sequences. We combine the policy with receding-horizon control to execute robust actions and preserve consistency. • Visual conditioning. We encode observations as conditions instead of generating them jointly. This enables real-time action inference.";
  const prose = "Sequence prediction is often avoided in policy learning because high-dimensional sampling is hard. It is difficult to specify the number of modes. In contrast, DDPM scales well with dimensions without losing model expressiveness. It represents actions as a sequence and addresses these issues.";
  const contentList = [
    { id: 0, type: "list", sub_type: "text", list_items: [listText], page_idx: 0, bbox: bbox([45, 633, 309, 722]) },
    { id: 1, type: "text", text: prose, page_idx: 0, bbox: bbox([45, 485, 309, 578]) },
    { id: 2, type: "text", text: "Right column reference text for layout testing. The translation appears alongside the original. Paragraph boundaries should remain visible.", page_idx: 0, bbox: bbox([325, 675, 580, 723]) },
    { id: 3, type: "text", text: "Another right column paragraph for testing. Source indentation is preserved independently. List markers are restored by the renderer.", page_idx: 0, bbox: bbox([325, 530, 580, 578]) },
  ];
  const translations = [
    ["**闭环动作序列。** 我们将策略与*滚动时域控制*结合，以稳健执行动作并保持时间一致性。", "**视觉条件。** 我们将观测编码为条件，而非联合生成，从而支持实时动作推断。"],
    ["策略学习往往避免序列预测，因为高维采样困难，且难以指定模态数量。", "相比之下，DDPM 能适应输出维度增长而不损失表达能力。它将动作表示为序列，解决以下问题。"],
  ];
  let raw;
  const pipeline = new D.Pipeline({ getPdfApp: () => app, llm: async (args) => {
    check("page request includes fixed source units", args.messages.some((m) => m.content.includes("Source layout units for 0_0")));
    check("source italic is sent to the model", args.messages.some((m) => m.content.includes("*receding-horizon control*")));
    return { content: JSON.stringify({ paragraphs: raw.map((p, i) => ({ id: `0_${p.paragraph_idx}`, paragraph_summary: "版式测试段落",
      point_split: [p.sentences.map((_, j) => j)], point_summaries: ["测试要点"], point_translations: ["旧版会挤在一起的扁平译文。"], point_importance_levels: [1],
      layout_translations: i < 2 ? p.translationLayout.units.map((u, j) => ({ unit_id: u.id, translation: translations[i][j] })) : [],
    })) }) };
  } });
  pipeline._summaryManager.setCharsDataList(chars);
  raw = pipeline.processSentenceData(pipeline.bboxMatch(pipeline.selectMainBlocks(contentList), [], chars));
  check("PDF bullets remain two list units", raw[0].translationLayout.units.length === 2 && raw[0].translationLayout.units.every((u) => u.marker === "•"));
  check("PDF indents identify two body paragraphs", raw[1].translationLayout.units.length === 2 && raw[1].translationLayout.units.every((u) => u.indentEm > 0.5));
  const result = await pipeline.llmRequest(raw);
  pipeline._summaryManager.setPageSizes({ 0: { width: 612, height: 792 } });
  pipeline._summaryManager.buildHierarchicalData(result);
  const hierarchy = D.Session.compactHierarchicalData(pipeline._summaryManager.hierarchicalData);
  s.data = { hierarchicalData: hierarchy, contentList };
  s.explanations = { p_0_0: { text: "列表的讲解", role: "method" }, p_0_1: { text: "正文的讲解", role: "contribution" } };
  s._emit("change"); s.overlay.setData(hierarchy); s.rail.refresh();
  const overlay = s.overlay, rail = s.rail, doc = rail.readerDoc;
  Zotero.getMainWindow().resizeTo(1450, 1000);
  await sleep(500);
  async function shot(name) {
    const win = Zotero.getMainWindow();
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), name), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  }
  const ps = overlay.pages.get(0);
  overlay.trPara = ps[0]; overlay.hoverPara = ps[0]; overlay._drawHover(ps[0]);
  let box = overlay.pdfDoc.querySelector(".dr-translation");
  check("both list markers render independently", box.querySelectorAll(".dr-list-marker").length === 2);
  check("list has hanging indentation", overlay.pdfWin.getComputedStyle(box.querySelector(".dr-layout-list")).display === "grid");
  check("bold labels and inline italic survive", box.querySelectorAll("strong").length === 2 && !!box.querySelector("em"));
  const rows = box.querySelectorAll(".dr-layout-unit");
  check("list starts remain vertically separated", rows[1].getBoundingClientRect().top > rows[0].getBoundingClientRect().top + 25);
  await shot("translation-lists.png");
  overlay.trPara = ps[1]; overlay.hoverPara = ps[1]; overlay._drawHover(ps[1]);
  box = overlay.pdfDoc.querySelector(".dr-translation");
  check("body renders as two separate paragraphs", box.querySelectorAll(".dr-layout-paragraph").length === 2);
  check("each paragraph has its own first-line indent", [...box.querySelectorAll(".dr-layout-paragraph")].every((p) => parseFloat(overlay.pdfWin.getComputedStyle(p).textIndent) > 5));
  check("body translation is not the flat point translation", !box.textContent.includes("旧版"));
  await shot("translation-paragraphs.png");
  overlay._setHover(null);

  const oldHit = overlay._hitTest;
  overlay._hitTest = () => ps[1];
  const event = { button: 0, clientX: 15, clientY: 15, target: overlay.pdfDoc.body };
  overlay._onPointerDown(event); overlay._onPointerUp(event); await sleep(100);
  let card = rail.cards.get("p_0_1").el;
  check("expanded card body is visible", doc.defaultView.getComputedStyle(card.querySelector(".dr-explain")).display !== "none");
  overlay._onPointerDown(event); overlay._onPointerUp(event); await sleep(100);
  overlay._hitTest = oldHit;
  card = rail.cards.get("p_0_1").el;
  check("second source click actually hides the body", card.classList.contains("dr-user-collapsed") && doc.defaultView.getComputedStyle(card.querySelector(".dr-explain")).display === "none");
  overlay.openParagraph(ps[1]); await sleep(100);
  check("navigation reopens an explicitly collapsed card", !rail.cards.get("p_0_1").el.classList.contains("dr-user-collapsed"));
  const colors = [];
  const contrast = (rgb) => {
    const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 1.05 / (channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 + 0.05);
  };
  for (const role of ["background", "gap", "prior", "contribution", "method", "result", "limitation"]) {
    s.explanations.p_0_1.role = role; s._emit("explanations"); await sleep(50);
    const node = rail.cards.get("p_0_1").el;
    colors.push(doc.defaultView.getComputedStyle(node).borderInlineStartColor);
    check(`role ${role} has a strong side stripe`, parseFloat(doc.defaultView.getComputedStyle(node).borderInlineStartWidth) >= 4);
    check(`role ${role} label contrast is readable`, contrast(doc.defaultView.getComputedStyle(node.querySelector(".dr-role")).backgroundColor) >= 4.5);
  }
  check("all seven roles have distinct accents", new Set(colors).size === 7);
  const theme = doc.documentElement.getAttribute("data-color-scheme");
  doc.documentElement.setAttribute("data-color-scheme", "dark");
  const darkColors = [];
  for (const role of ["contribution", "method", "result"]) {
    s.explanations.p_0_1.role = role; s._emit("explanations"); await sleep(50);
    darkColors.push(doc.defaultView.getComputedStyle(rail.cards.get("p_0_1").el.querySelector(".dr-phead")).backgroundColor);
  }
  check("roles stay distinct in dark mode", new Set(darkColors).size === 3);
  if (theme === null) doc.documentElement.removeAttribute("data-color-scheme"); else doc.documentElement.setAttribute("data-color-scheme", theme);
  s.explanations.p_0_1.role = "contribution"; s._emit("explanations");
  await D.Store.savePaper(s.key, s.item.id, { hierarchical_data: hierarchy });
  const stored = await D.Store.getPaper(s.key);
  check("layout contract persists", stored.hierarchical_data[0].paragraphs[0].translationLayout.units[1].kind === "list-item");

  // Repair a legacy flattened cache without rerunning MinerU or the entire deep read.
  s.data = { hierarchicalData: hierarchy.map((page) => ({ ...page, paragraphs: page.paragraphs.map((p) => ({ ...p, translationLayout: null, translationLayoutVersion: 0 })) })), contentList };
  const savedComplete = D.LLM.complete;
  let repairCalls = 0;
  D.LLM.complete = async (args) => {
    repairCalls++;
    const units = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
    return { content: JSON.stringify({ translations: units.map((u) => ({ id: u.id, translation: translations[Number(u.id.split(":")[0])][Number(u.id.split("u")[1])] })) }) };
  };
  try {
    await s.restoreTranslationLayout();
    check("legacy repair batches the missing structure", repairCalls === 1);
    check("legacy bullet and paragraph structure restored", s.data.hierarchicalData[0].paragraphs.slice(0, 2).every((p) => p.translationLayoutVersion === 1 && p.translationLayout.units.length === 2));
  }
  finally { D.LLM.complete = savedComplete; }
  await sleep(800);
  return { checks: E2E.result.steps.length };
};

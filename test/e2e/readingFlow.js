/* Reading experience regressions in real Zotero; uses the offline typography PDF.
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/typography.pdf scripts/e2e.sh test/e2e/readingFlow.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, value) => { E2E.result.steps.push({ name, ok: !!value }); if (!value) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead; i++) await sleep(100);
  const D = Zotero.DeepRead;
  D.prefs.set("cards.autoExplain", false);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const s = D.Session.forReader(reader);
  await s.init();
  const rect0 = [50, 680, 280, 700], rect1 = [50, 654, 280, 674];
  const para = (i, text, rect) => ({ paragraphIndex: i, paragraphType: "text", paragraphText: text, paragraphSummary: `段落 ${i + 1}`,
    rects: [rect], typography: { fontSize: 10 }, points: [{ id: `0_${i}_point_0`, summary: "关键要点", importance_level: 1, rects: [rect], translation: "**重要结果。** 普通说明。" }] });
  const first = para(0, "The new method combines two complementary representations to improve", rect0);
  const second = para(1, "the accuracy of the model on the main task, without extra data.", rect1);
  s.data = { hierarchicalData: [{ pageIndex: 0, paragraphs: [first, second] }], contentList: [] };
  s.explanations = { p_0_0: { text: "第一部分讲解" }, p_0_1: { text: "第二部分讲解" } };
  s._emit("change");
  s.overlay.setData(s.data.hierarchicalData);
  s.rail.refresh();
  await sleep(500);
  const overlay = s.overlay, rail = s.rail, [p0, p1] = overlay.pages.get(0);
  check("removed panels and modules", !D.Panes.paneIDs.glossary && !D.Panes.paneIDs.flashcards && !D.Panes.paneIDs.code && !D.Flashcards && !D.Glossary && !D.GitHub && !D.DeepWiki);
  check("automatic fragment grouping", s.groupLead("p_0_1") === "p_0_0" && rail._items().filter((x) => x.kind === "paragraph").length === 1);
  // Exercise the source click handler, including keep-open and grouped followers.
  const hit = overlay._hitTest;
  overlay._hitTest = () => p0;
  const event = { button: 0, buttons: 0, clientX: 10, clientY: 10, target: overlay.pdfDoc.body };
  overlay._onPointerDown(event); overlay._onPointerUp(event);
  check("source click opens card", rail.isOpen("p_0_0"));
  overlay._hitTest = () => p1;
  overlay._onPointerDown(event); overlay._onPointerUp(event);
  check("second source click closes grouped card", !rail.isOpen("p_0_0"));
  overlay._hitTest = hit;
  overlay.openParagraph(p1); overlay.openParagraph(p1);
  check("source navigation keeps card open", rail.isOpen("p_0_0"));
  rail.collapseAll();
  s.userState.notes = { p_0_1: { text: "保留我的笔记" } };
  s.splitCard("p_0_0");
  check("manual split", s.groupLead("p_0_1") === "p_0_1");
  s.mergeCardWithPrevious("p_0_1");
  check("manual merge preserves notes", s.groupMembers("p_0_0").length === 2 && s.paragraphNote("p_0_1") === "保留我的笔记");

  overlay.setOptions({ highlights: true });
  check("legacy points visibly highlighted", overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length > 0);
  overlay.setOptions({ highlights: false });
  check("highlight switch removes ink", overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length === 0);
  overlay.setOptions({ highlights: true });
  s.setPointImportance(first.points[0].id, 1);
  check("manual highlight removal persists", s.pointLevel(first.points[0]) === 1);
  s.setPointImportance(first.points[0].id, 3);
  check("manual highlight colour appears", overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length > 0);

  p0.points[0].translation = "**重要结果。** " + "完整保留数字、限定条件和技术含义。".repeat(40);
  overlay._suppressPara = null;
  overlay.hoverPara = p0; overlay.trPara = p0;
  overlay._drawHover(p0);
  const box = overlay.pdfDoc.querySelector(".dr-translation");
  const geom = overlay._geometry(0), pct = overlay._toPercent(geom, p0.bbox);
  const rendered = box.getBoundingClientRect();
  check("translation exact source width", Math.abs(rendered.width - geom.div.clientWidth * pct.width / 100) < 1.5);
  check("translation fits source height", Math.abs(rendered.height - geom.div.clientHeight * pct.height / 100) < 7);
  check("long translation remains complete", box.textContent.includes("技术含义") && box.scrollHeight > box.clientHeight && box.dataset.overflow === "true");
  check("bounded font reduction", Number(box.dataset.scale) >= 0.82 && Number(box.dataset.scale) <= 1);
  box.scrollTop = 100;
  check("overflow can scroll", box.scrollTop > 0);
  overlay._onPointerMove({ target: box, buttons: 0, altKey: false });
  check("moving onto translation preserves it", !!overlay.pdfDoc.querySelector(".dr-translation"));
  check("bold and ordinary words preserved", !!box.querySelector("strong") && box.querySelector("strong").textContent.length < box.textContent.length);

  // Exercise the actual question-pane UI without calling any remote model.
  const doc = rail.readerDoc;
  const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  doc.body.append(host);
  s.userState.recallMode = true;
  s.userState.recallAnswers = { q1: { question: "为什么这样设计？", text: "我自己的解释" } };
  s.questions = { items: [{ id: "q1", question: "为什么这样设计？", answer: "用于对照的 AI 回答", keys: ["p_0_0"] }] };
  D.Panes.renderers.questions({ body: host, doc, session: s, event: "change", h: (...args) => D.util.h(doc, ...args) });
  check("recall hides answer until requested", !host.querySelector(".dr-q-answer") && !!host.querySelector(".dr-q-reveal"));
  check("recall restores the user's answer", host.querySelector(".dr-q-recall").value === "我自己的解释");
  host.querySelector(".dr-q-reveal").click();
  D.Panes.renderers.questions({ body: host, doc, session: s, event: "change", h: (...args) => D.util.h(doc, ...args) });
  check("recall can reveal comparison", !!host.querySelector(".dr-q-answer"));
  s.setReadingGoal("method", "我想弄清关键设计为什么有效");
  D.Panes.renderers.questions({ body: host, doc, session: s, event: "change", h: (...args) => D.util.h(doc, ...args) });
  check("reading goal controls restore saved values", host.querySelector(".dr-goal-kind").value === "method" && host.querySelector(".dr-goal-text").value.includes("关键设计"));

  // A real figure card: edit evidence separately from the AI's reading steps.
  s.data.contentList = [{ id: 1, type: "image", page_idx: 0, bbox: [82, 267, 458, 558], image_caption: ["Figure 1: Measured performance."] }];
  const figure = s.figures()[0];
  s.figureGuides[figure.id] = { steps: [{ text: "AI 给出的读图步骤" }] };
  rail.refresh();
  await sleep(350);
  let figureCard = rail.cards.get(`g_${figure.id}`).el;
  check("AI figure steps start collapsed", !!figureCard.querySelector(".dr-figure-guide") && !figureCard.querySelector(".dr-figure-guide").open);
  figureCard.querySelector(".dr-evidence-edit").click();
  await sleep(150);
  figureCard = rail.cards.get(`g_${figure.id}`).el;
  const values = { setup: "比较 A 和 B 的准确率", observation: "A 的均值更高", interpretation: "<strong>样本有限</strong>，不能证明泛化" };
  for (const [key, value] of Object.entries(values)) {
    const input = figureCard.querySelector(`[data-field="${key}"]`);
    input.value = value;
    input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  }
  figureCard.querySelector(".dr-evidence-save").click();
  await sleep(200);
  check("evidence form saves all fields", Object.entries(values).every(([key, value]) => s.figureNote(figure.id)[key] === value));
  check("evidence note is separate from AI steps", rail.cards.get(`g_${figure.id}`).el.textContent.includes("A 的均值更高") && s.figureGuides[figure.id].steps[0].text.includes("AI"));
  check("reading record includes personal notes and goal", s.readingRecord().includes(values.observation) && s.readingRecord().includes("关键设计"));
  const savedNote = await s.saveReadingNote();
  check("Zotero note preserves literal user text", savedNote.getNote().includes("&lt;strong&gt;") && !savedNote.getNote().includes("<strong>样本有限</strong>"));

  // The manual-only option changes the actual PDF overlay but retains manual ink.
  s.userState.pointImportance = {};
  s.setHighlightDensity("manual");
  check("manual-only mode hides automatic highlights", overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length === 0);
  s.setPointImportance(first.points[0].id, 3);
  check("manual-only mode preserves user highlights", overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length > 0);
  s.setHighlightDensity("detailed");
  check("density preference is per paper", s.userState.highlightDensity === "detailed");
  doc.querySelector(".deepread-toolbar .dr-menu-button").click();
  const densityControl = doc.querySelector(".dr-highlight-density");
  densityControl.value = "sparse";
  densityControl.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  check("density menu updates the live session", s.highlightDensity === "sparse");
  const indexOfHighlights = D.Modules.LIST.findIndex((m) => m.key === "highlights");
  doc.querySelectorAll(".deepread-menu .dr-feature")[indexOfHighlights].click();
  check("density control disables when highlights are off", densityControl.disabled);
  doc.querySelectorAll(".deepread-menu .dr-feature")[indexOfHighlights].click();
  check("density control enables when highlights are on", !densityControl.disabled);
  doc.body.dispatchEvent(new doc.defaultView.Event("pointerdown", { bubbles: true }));

  await sleep(700);
  const stored = await D.Store.getPaper(s.key);
  check("goals and evidence persist to SQLite", stored.user_state.readingGoal.kind === "method" && stored.user_state.figureNotes[figure.id].observation === values.observation);
  host.remove();
  D.Panes.reveal(reader, "questions");
  s._emit("questions");
  overlay._setHover(null);
  await reader.navigate({ pageIndex: 0 });
  const win = Zotero.getMainWindow();
  win.resizeTo(1550, 1000);
  await sleep(600);
  const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "reading-methods.png"), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  // Run the real session completion path with a local parser result and no API calls.
  const originalPipeline = s._newPipeline, originalConfig = s._checkConfig, originalAuto = s._autoGenerate;
  s._checkConfig = () => {};
  s._autoGenerate = () => {};
  s.userState.modules = { ...(s.userState.modules || {}), figureCards: false };
  s._newPipeline = () => ({ run: async () => ({ hierarchicalData: [{ pageIndex: 0, paragraphs: [first, second] }], contentList: s.data.contentList }) });
  await s.run();
  s._newPipeline = originalPipeline; s._checkConfig = originalConfig; s._autoGenerate = originalAuto;
  const reparsed = await D.Store.getPaper(s.key);
  check("reparse retains goals, evidence, self-answers and aligned notes", reparsed.user_state.readingGoal.kind === "method"
    && reparsed.user_state.figureNotes[figure.id].observation === values.observation
    && reparsed.user_state.recallAnswers.q1.text === "我自己的解释"
    && reparsed.user_state.notes.p_0_1.text === "保留我的笔记");
  host.remove();
  await sleep(800); // allow only the isolated test profile's debounced saves to flush
  return { checks: E2E.result.steps.length };
};

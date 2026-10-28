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
  host.remove();
  await sleep(800); // allow only the isolated test profile's debounced saves to flush
  return { checks: E2E.result.steps.length };
};

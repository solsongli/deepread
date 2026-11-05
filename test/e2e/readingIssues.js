/* Local revisit flags preserve source ownership across grouping and reparsing.
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/typography.pdf scripts/e2e.sh test/e2e/readingIssues.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead;
  D.prefs.set("cards.autoExplain", false);
  D.prefs.set("view.railLayout", "right");
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const para = (i, text, y) => ({ paragraphIndex: i, paragraphType: "text", paragraphText: text,
    paragraphSummary: i ? "实验支持到什么范围" : "方法与对照条件", rects: [[50, y - 25, 280, y]],
    typography: { fontSize: 10 }, points: [{ id: `0_${i}_point_0`, summary: "检查实验依据", importance_level: 1, rects: [[50, y - 25, 280, y]] }] });
  const p0 = para(0, "The method uses the same data split for every comparison.", 700);
  const p1 = para(1, "The experiment measures accuracy on a small held-out sample.", 580);
  s.data = { hierarchicalData: [{ pageIndex: 0, paragraphs: [p0, p1] }], contentList: [] };
  s.explanations = { p_0_0: { text: "核对对照条件。", role: "method" }, p_0_1: { text: "检查样本与统计范围。", role: "result" } };
  s.userState.modules = { ...(s.userState.modules || {}), questions: false };
  s._emit("change"); s.overlay.setData(s.data.hierarchicalData); s.rail.refresh();
  const rail = s.rail, rdoc = rail.readerDoc, main = Zotero.getMainWindow(), doc = main.document;
  main.resizeTo(1400, 1000);
  const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  host.style.cssText = "position:fixed;right:10px;top:150px;width:310px;max-height:740px;overflow:auto;padding:12px;background:var(--material-background,#fff);z-index:9999";
  doc.documentElement.append(host);
  const render = (event = "change") => D.Panes.renderers.questions({ body: host, doc, session: s, event, h: (...args) => D.util.h(doc, ...args) });
  const unsubscribe = s.on((event) => render(event));
  const originalComplete = D.LLM.complete;
  let calls = 0;
  D.LLM.complete = async () => { calls++; throw new Error("Unexpected model call in local review test"); };
  try {
    await sleep(200);
    s.overlay.openParagraph(s.overlay.pages.get(0)[1]); await sleep(100);
    const flag = () => rail.cards.get("p_0_1")?.el.querySelector('[data-dr-action="review:p_0_1"]');
    flag().focus(); flag().click(); await sleep(100);
    check("source action creates a physical paragraph flag", s.needsReview("p_0_1") && !s.needsReview("p_0_0"));
    check("flag action preserves focus and pressed state", rdoc.activeElement === flag() && flag().getAttribute("aria-pressed") === "true");
    check("local queue remains available with AI questions disabled", !!host.querySelector('[data-review-key="p_0_1"]') && !host.querySelector(".dr-q-add"));
    host.querySelector(".dr-review-source").focus(); s._emit("progress");
    check("disabled AI module preserves review keyboard focus on refresh", doc.activeElement === host.querySelector(".dr-review-source"));
    check("flag saves complete source text", s.userState.readingIssues.p_0_1.quote === p1.paragraphText);
    s.setParagraphNote("p_0_1", "样本量是否足以支持泛化？");
    s.setPointImportance(p1.points[0].id, 3);
    check("review queue shows the reader's existing explanation", host.querySelector(".dr-review-note").textContent.includes("样本量"));
    s.mergeCardWithPrevious("p_0_1"); s.overlay.openParagraph(s.overlay.pages.get(0)[1]); await sleep(100);
    const merged = rail.cards.get("p_0_0").el;
    check("merged source flags remain independent", merged.querySelector('[data-dr-action="review:p_0_1"]').getAttribute("aria-pressed") === "true"
      && merged.querySelector('[data-dr-action="review:p_0_0"]').getAttribute("aria-pressed") === "false");
    rail.closeParagraph("p_0_0"); await sleep(100);
    check("compact group retains a visible review badge", rdoc.defaultView.getComputedStyle(rail.cards.get("p_0_0").el.querySelector(".dr-badges")).display !== "none"
      && !!rail.cards.get("p_0_0").el.querySelector(".dr-badge-review"));
    s.splitCard("p_0_0"); await sleep(100);
    check("splitting never transfers the flag to another paragraph", s.needsReview("p_0_1") && !s.needsReview("p_0_0"));
    s.setCardHidden("p_0_1", true);
    host.querySelector(".dr-review-source").click(); await sleep(150);
    check("review entry returns to and opens the exact source even if hidden", rail.focusParagraphKey === "p_0_1" && rail.isOpen("p_0_1") && !s.isCardHidden("p_0_1"));
    const clear = host.querySelector(".dr-review-remove"); clear.focus(); clear.click(); await sleep(100);
    check("removing a flag leaves notes and highlights intact", !s.needsReview("p_0_1") && s.paragraphNote("p_0_1").includes("样本量") && s.pointLevel(p1.points[0]) === 3);
    check("removal returns keyboard focus to the review heading", doc.activeElement === host.querySelector(".dr-review-list > summary"));
    s.setNeedsReview("p_0_1", true);
    await sleep(650);
    const stored = await D.Store.getPaper(s.key);
    check("review flag persists to SQLite", stored.user_state.readingIssues.p_0_1.quote === p1.paragraphText);
    s.userState = JSON.parse(JSON.stringify(stored.user_state));
    check("serialized flags reopen without depending on live objects", s.readingIssuesList()[0].key === "p_0_1");
    const before = s.data.hierarchicalData;
    const after = [{ pageIndex: 0, paragraphs: [{ ...p1, paragraphIndex: 7 }, { ...p0, paragraphIndex: 8 }] }];
    s.userState = D.Reading.carryState(s.userState, before, after);
    s.data.hierarchicalData = after; s.overlay.setData(after); s._emit("change");
    check("reparse moves flag by unique source text", s.needsReview("p_0_7") && !s.needsReview("p_0_1"));
    const changed = [{ pageIndex: 0, paragraphs: [{ ...p0, paragraphIndex: 7 }] }];
    s.userState = D.Reading.carryState(s.userState, after, changed);
    s.data.hierarchicalData = changed; s.overlay.setData(changed); s._emit("change");
    check("changed source stays visible as an unlocated review", !s.needsReview("p_0_7") && host.querySelector(".dr-review-unmapped .dr-review-quote").textContent === p1.paragraphText);
    check("export retains the unlocated source and personal note", s.readingRecord().includes(p1.paragraphText) && s.readingRecord().includes("样本量"));
    s.userState = D.Reading.carryState(s.userState, changed, changed); s._emit("change");
    check("repeated parsing does not duplicate unlocated flags", host.querySelectorAll(".dr-review-unmapped").length === 1);
    host.querySelector(".dr-review-unmapped button").click();
    check("unlocated review can be removed without deleting the note", s.userState.unmappedReadingIssues.length === 0 && s.userState.unmappedNotes.some((note) => note.text.includes("样本量")));
    check("review workflow makes no model requests", calls === 0);
    s.setNeedsReview("p_0_7", true);
    s.userState.unmappedReadingIssues = Array.from({ length: 12 }, (_, i) => ({ id: `long:${i}`, quote: `原文位置 ${i}。` + "完整保留待核对的内容。".repeat(5) }));
    s._emit("review");
    const scrolling = host.querySelector(".dr-review-items"); scrolling.scrollTop = 150;
    s._emit("progress");
    check("background refresh preserves the review list scroll position", host.querySelector(".dr-review-items").scrollTop === 150);
    s.userState.unmappedReadingIssues = []; s._emit("review");
    check("narrow review panel has no horizontal overflow", host.scrollWidth <= host.clientWidth + 1);
    await sleep(150);
    const bitmap = await main.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "reading-issues.png"), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
    await sleep(700);
  }
  finally { D.LLM.complete = originalComplete; unsubscribe(); host.remove(); }
  return { checks: E2E.result.steps.length };
};

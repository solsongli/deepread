/* Responsive paper navigation in a real Zotero PDF reader; all data is a local fixture.
 * E2E_BASE=$PWD/.test-profile/structure-ux E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/continuations.pdf scripts/e2e.sh test/e2e/structureBar.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, value) => { E2E.result.steps.push({ name, ok: !!value }); if (!value) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead, win = Zotero.getMainWindow();
  D.prefs.set("cards.autoExplain", false);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const titles = ["1 Introduction", "2 Background", "3 Method and experimental design for sequential prediction", "4 Experiments", "5 Results", "6 Limitations", "7 Conclusions"];
  const contentList = titles.map((text, i) => ({ id: i, type: "text", text_level: 1, text, page_idx: i < 4 ? 0 : 1, bbox: [80, 50 + i % 4 * 200, 920, 80 + i % 4 * 200] }));
  contentList.push({ id: 8, type: "image", page_idx: 0, bbox: [80, 300, 920, 520], image_caption: ["Figure 1: Local test fixture."] });
  const p = (paragraphIndex, text, rect) => ({ paragraphIndex, paragraphType: "text", paragraphText: text, paragraphSummary: text, bbox: rect, rects: [rect], points: [{ id: `point_${paragraphIndex}`, summary: text, importance_level: 3, importance_source: "model", rects: [rect] }] });
  s.data = { contentList, hierarchicalData: [
    { pageIndex: 0, paragraphs: [p(0, "The method combines two representations.", [50, 680, 280, 700]), p(1, "A local experimental control.", [50, 330, 280, 350])] },
    { pageIndex: 1, paragraphs: [p(0, "A separate experimental result.", [50, 680, 280, 700])] },
  ] };
  s.userState.modules = { ...(s.userState.modules || {}), cards: false, figureCards: false, structureBar: true, skim: true, questions: true };
  s.questions = { items: Array.from({ length: 24 }, (_, i) => ({ id: `q${i + 1}`, question: `Question ${i + 1}: Which evidence supports this design?`, answer: "Local fixture answer", keys: ["p_0_0"] })) };
  s.overlay.setData(s.data.hierarchicalData); s._emit("change");
  const bar = s.structureBar, doc = bar.readerDoc;
  const originalReveal = D.Panes.reveal, originalOpen = s.openBlock, originalGoKey = bar.goKey;
  const originalTheme = doc.documentElement.getAttribute("data-color-scheme");
  const hadThemePref = Services.prefs.prefHasUserValue("ui.systemUsesDarkTheme");
  const themePref = Services.prefs.getIntPref("ui.systemUsesDarkTheme", 0);
  let source = null;
  const screenshot = async (name) => {
    await sleep(150);
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), name), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  };
  try {
    D.Panes.reveal = () => {};
    s.openBlock = (page, para) => { source = { page, para }; };
    win.resizeTo(1550, 950);
    await sleep(500); bar.refresh(); await sleep(150);
    check("all sections remain available", bar.sections.length === 7 && bar.sectionPicker.options.length === 8);
    check("section selector keeps unabridged heading", [...bar.sectionPicker.options].some((option) => option.textContent.includes("Method and experimental design for sequential prediction")));
    check("dense question sources remain individually selectable", bar.questionPicker.options.length === 25);
    check("overlapping map markers are hidden", bar.qmarks.every(({ mark }) => mark.hidden));
    check("question navigation uses native keyboard controls", bar.questionPicker.tabIndex === 0 && bar.qmarks.every(({ mark }) => mark.localName === "button"));
    bar.questionPicker.value = "p_0_0";
    bar.questionPicker.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
    check("question selector opens exact evidence and resets", source?.page === 0 && source?.para === 0 && bar.questionPicker.value === "");
    const oldRoot = bar.root;
    const depth = bar.depth.querySelector('[data-mode="key"]'); depth.focus(); depth.click();
    await sleep(80);
    check("skim change preserves the mounted control and keyboard focus", bar.root === oldRoot && doc.activeElement === depth && depth.getAttribute("aria-pressed") === "true");
    bar.questionPicker.focus(); bar.refresh(); await sleep(30);
    check("progress refresh preserves open selector element", bar.root === oldRoot && doc.activeElement === bar.questionPicker);
    check("progress is labelled as position reached", bar.readLabel.textContent === D.bilingual(`浏览至 ${Math.min(100, Math.round((s.userState.readUpTo / 2) * 100))}%`, `${Math.min(100, Math.round((s.userState.readUpTo / 2) * 100))}% reached`));
    check("partial progress does not split section text colours", bar.segs.every((seg) => seg.style.backgroundSize === "100% 3px"));
    const allQuestions = s.questions.items;
    s.questions.items = allQuestions.slice(0, 1); bar.refresh(); await sleep(50);
    check("sparse source markers stay visible on the map", bar.qmarks.length === 1 && !bar.qmarks[0].mark.hidden);
    source = null; bar.qmarks[0].mark.click();
    check("map source button still opens exact paragraph", source?.page === 0 && source?.para === 0);
    s.questions.items = allQuestions; bar.refresh(); await sleep(50);

    // Exercise the real keyboard handler with composition and editable descendants.
    const calls = [];
    bar.goKey = (dir) => { calls.push(dir); return true; };
    const key = (extra = {}) => ({ key: "n", target: bar.pdfWin.document.body, preventDefault() { this.prevented = true; }, ...extra });
    bar._onKey(key({ isComposing: true })); bar._onKey(key({ keyCode: 229 }));
    check("IME events never jump to key paragraphs", calls.length === 0);
    const editor = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"); editor.setAttribute("role", "textbox");
    const child = doc.createElementNS("http://www.w3.org/1999/xhtml", "span"); editor.append(child); doc.body.append(editor);
    bar._onKey(key({ target: child })); bar._onKey(key({ target: bar.questionPicker })); editor.remove();
    bar._onKey(key({ ctrlKey: true })); bar._onKey(key({ defaultPrevented: true })); bar._onKey(key({ repeat: true }));
    check("editors, native selectors and handled key events keep their input", calls.length === 0);
    bar._onKey(key()); bar._onKey(key({ key: "N", shiftKey: true }));
    check("plain N and Shift N keep forward and backward navigation", calls.join(",") === "1,-1");
    bar.goKey = originalGoKey;

    await screenshot("structure-wide.png");
    win.resizeTo(520, 900);
    reader.toggleSidebar(true);
    reader.setSidebarWidth(420);
    await sleep(400); bar._update(); await sleep(80);
    E2E.result.narrow = { window: win.innerWidth, reader: doc.defaultView.innerWidth, bar: bar.root.clientWidth, map: bar.map.clientWidth, label: bar.readLabel.offsetWidth, height: bar.root.getBoundingClientRect().height };
    await screenshot("structure-narrow.png");
    check("narrow reader uses complete section chooser", !bar.sectionPicker.hidden);
    check("bar wraps instead of horizontal overflow", bar.root.scrollWidth <= bar.root.clientWidth + 1 && bar.root.getBoundingClientRect().height > 35);
    const splitTop = parseFloat(doc.defaultView.getComputedStyle(doc.getElementById("split-view")).top);
    check("PDF viewport stays below all wrapped controls", Math.abs(splitTop - bar.root.getBoundingClientRect().bottom) < 2);
    for (const node of bar.controls.children) if (node.getClientRects().length) {
      const box = node.getBoundingClientRect(), outer = bar.root.getBoundingClientRect();
      check(`control remains in narrow viewport: ${node.className}`, box.left >= outer.left - 1 && box.right <= outer.right + 1 && box.bottom <= outer.bottom + 1);
    }
    const heading = bar.sections[2];
    bar.sectionPicker.value = "2";
    bar.sectionPicker.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
    await sleep(150);
    const current = bar._positionAt(bar.app.pdfViewer.container.scrollTop);
    check("compact section chooser scrolls to heading", Math.abs(current - heading.start) < 0.08);
    await screenshot("structure-narrow.png");
    Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
    doc.documentElement.setAttribute("data-color-scheme", "dark");
    await sleep(200);
    check("dark controls remain readable", doc.defaultView.getComputedStyle(bar.root.querySelector(".dr-nextkey")).color === "rgb(251, 191, 36)");
    await screenshot("structure-dark.png");

    reader.setSidebarWidth(590);
    await sleep(300); bar._update(); await sleep(50);
    E2E.result.tight = { width: bar.root.clientWidth, height: bar.root.getBoundingClientRect().height };
    check("tighter reading area never pushes controls outside the viewport", bar.root.scrollWidth <= bar.root.clientWidth + 1 && [...bar.controls.children].filter((node) => node.getClientRects().length).every((node) => node.getBoundingClientRect().right <= bar.root.getBoundingClientRect().right + 1));
    check("spacing tracks additional wrapped rows", Math.abs(parseFloat(doc.defaultView.getComputedStyle(doc.getElementById("split-view")).top) - bar.root.getBoundingClientRect().bottom) < 2);
    await screenshot("structure-tight.png");

    const rootBeforeRemove = bar.root;
    s.userState.modules.structureBar = false; s.userState.modules.skim = false; bar.refresh();
    check("disabling bar releases added PDF spacing", !rootBeforeRemove.isConnected && !doc.body.classList.contains("deepread-has-bar") && !doc.body.style.getPropertyValue("--deepread-bar-height"));
    return { checks: E2E.result.steps.length };
  }
  finally {
    D.Panes.reveal = originalReveal; s.openBlock = originalOpen; bar.goKey = originalGoKey;
    if (originalTheme === null) doc.documentElement.removeAttribute("data-color-scheme"); else doc.documentElement.setAttribute("data-color-scheme", originalTheme);
    if (hadThemePref) Services.prefs.setIntPref("ui.systemUsesDarkTheme", themePref); else Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
    await sleep(500);
  }
};

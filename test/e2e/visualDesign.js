/* Card action menus and shared visual hierarchy, exercised in real Zotero.
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/paragraph-layout.pdf scripts/e2e.sh test/e2e/visualDesign.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead, main = Zotero.getMainWindow();
  D.prefs.set("cards.autoExplain", false); D.prefs.set("view.railLayout", "right"); D.prefs.set("view.railWidth", 320);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const p = (i, text, title, rect) => ({ paragraphIndex: i, paragraphType: "text", paragraphText: text, paragraphSummary: title,
    rects: [rect], typography: { fontSize: 12 }, points: [{ id: `point_${i}`, summary: "把方法的设计动机与实验支持分开核对。", importance_level: 1, importance_source: "model", rects: [rect], translation: "**保留关键条件。** 译文仍可按需展开。" }] });
  s.data = { contentList: [], hierarchicalData: [{ pageIndex: 0, paragraphs: [
    p(0, "The policy combines closed-loop action sequences with visual conditioning.", "闭环动作与视觉条件如何配合", [45, 633, 309, 722]),
    p(1, "Sequence prediction has limitations that require careful experimental evaluation.", "实验结论与适用边界", [45, 485, 309, 578]),
    p(2, "An independent comparison explains the evaluation conditions.", "对照条件需要单独核对", [325, 675, 580, 723]),
  ] }] };
  s.explanations = {
    p_0_0: { role: "method", text: "**先看设计动机。** 策略一次预测一段动作，再利用新观测持续调整后续执行。\n\n阅读时可以分两步：先确认输入和输出，再检查哪些实验支持这一设计。" },
    p_0_1: { role: "limitation", text: "先确认评估条件，再判断结果可以推广到什么范围。" },
    p_0_2: { role: "result", text: "核对数据划分、比较对象和指标，避免把设置差异误当成方法收益。" },
  };
  s.userState.notes = { p_0_0: { text: "我还想核对：预测长度变化时，稳定性是否也有变化？" } };
  s._emit("change"); s.overlay.setData(s.data.hierarchicalData); s.rail.refresh();
  main.resizeTo(1420, 1000); await sleep(400);
  const rail = s.rail, doc = rail.readerDoc, win = doc.defaultView;
  const card = (key = "p_0_0") => rail.cards.get(key)?.el;
  const more = (key = "p_0_0") => card(key).querySelector('[data-dr-action="more"]');
  const menu = () => doc.querySelector(".deepread-card-menu");
  const key = (value) => doc.activeElement.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  s.overlay.openParagraph(s.overlay.pages.get(0)[0]); await sleep(100);
  check("theme is installed in all three document contexts", main.document.getElementById("deepread-theme-css") && doc.getElementById("deepread-theme-css") && s.overlay.pdfDoc.getElementById("deepread-theme-css"));
  check("card exposes exactly three clear primary actions", card().querySelectorAll(".dr-ractions button").length === 3
    && ["note", "ask", "more"].every((name) => card().querySelector(`[data-dr-action="${name}"]`)));
  check("primary actions have usable pointer targets", [...card().querySelectorAll(".dr-ractions button")].every((b) => b.getBoundingClientRect().height >= 26));
  const actionHeight = card().offsetHeight;
  more().focus(); more().click();
  check("more menu is outside the scrolling card", menu()?.parentNode === doc.body && !card().contains(menu()) && card().offsetHeight === actionHeight);
  check("menu opens with keyboard focus and expanded state", menu().contains(doc.activeElement) && more().getAttribute("aria-expanded") === "true");
  const actions = [...menu().querySelectorAll("button")]; key("ArrowDown");
  check("arrow keys reach the next action", doc.activeElement === actions[1]);
  key("End"); check("End reaches the separated hide action", doc.activeElement.dataset.action === "hide");
  key("Home"); check("Home returns to first action", doc.activeElement === actions[0]);
  key("Escape"); check("Escape restores more button focus", !menu() && doc.activeElement === more() && more().getAttribute("aria-expanded") === "false");
  more().click(); menu().querySelector('[data-action="edit"]').click();
  const summary = card().querySelector(".dr-rsummary");
  check("menu edit transfers focus into summary", !menu() && summary.isContentEditable && doc.activeElement === summary);
  key("Escape"); await sleep(80);
  const originalCopy = D.util.copyToClipboard; let copied;
  D.util.copyToClipboard = (text) => { copied = text; };
  try { more().click(); menu().querySelector('[data-action="copy-summary"]').click(); }
  finally { D.util.copyToClipboard = originalCopy; }
  check("copy moved into menu still contains summary and key points", copied.includes("闭环动作") && copied.includes("设计动机"));
  more().click(); s._emit("explanations"); await sleep(100);
  check("background card rebuild closes menu and preserves action focus", !menu() && doc.activeElement === more());
  more().click(); s.overlay.pdfDoc.body.dispatchEvent(new s.overlay.pdfWin.Event("pointerdown", { bubbles: true }));
  check("clicking the PDF dismisses card menu", !menu());
  more().click(); main.document.documentElement.dispatchEvent(new main.Event("pointerdown", { bubbles: true }));
  check("clicking the main Zotero pane dismisses card menu", !menu());
  D.prefs.set("view.railWidth", 200); await sleep(100);
  check("narrow cards keep all primary controls within their boundary", card().scrollWidth <= card().clientWidth + 1);
  more().click();
  const rect = menu().getBoundingClientRect();
  check("menu remains inside reader viewport at narrow width", rect.left >= 0 && rect.right <= doc.documentElement.clientWidth + 1 && rect.top >= 0 && rect.bottom <= doc.documentElement.clientHeight + 1);
  key("Escape");
  D.prefs.set("view.cardFontSize", 18); await sleep(100);
  const narrow = card().getBoundingClientRect();
  check("largest text keeps every expanded-card action inside the narrow rail", card().scrollWidth <= card().clientWidth + 1
    && [...card().querySelectorAll(".dr-ractions button")].every((b) => b.getBoundingClientRect().left >= narrow.left && b.getBoundingClientRect().right <= narrow.right));
  D.prefs.set("view.cardFontSize", 13);
  D.prefs.set("view.railWidth", 320); await sleep(100);
  s.overlay.openParagraph(s.overlay.pages.get(0)[1]); await sleep(100);
  more("p_0_1").click(); menu().querySelector('[data-action="merge"]').click(); await sleep(100);
  check("merge action keeps source ownership and focuses the resulting card", s.groupLead("p_0_1") === "p_0_0" && doc.activeElement === card().querySelector(".dr-rsummary"));
  card().querySelector(".dr-rsummary").click(); await sleep(100);
  more().click(); menu().querySelector('[data-action="split"]').click(); await sleep(100);
  check("split action remains available and retains personal notes", s.groupLead("p_0_1") === "p_0_1" && s.paragraphNote("p_0_0").includes("预测长度"));
  s.overlay.openParagraph(s.overlay.pages.get(0)[1]); await sleep(100);
  more("p_0_1").click(); menu().querySelector('[data-action="hide"]').click(); await sleep(100);
  check("hide removes its owner and leaves no detached menu", !menu() && !card("p_0_1") && s.isCardHidden("p_0_1"));
  s.showHiddenCards(); s.overlay.openParagraph(s.overlay.pages.get(0)[0]); await sleep(100);
  const luminance = (color) => {
    const c = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const shot = async (name) => {
    await sleep(160);
    const bitmap = await main.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), name), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  };
  const rootTheme = doc.documentElement.getAttribute("data-color-scheme");
  const pdfTheme = s.overlay.pdfDoc.documentElement.getAttribute("data-color-scheme");
  s.setFocusReading(true); await sleep(100);
  for (const mode of ["light", "dark"]) {
    doc.documentElement.setAttribute("data-color-scheme", mode); s.overlay.pdfDoc.documentElement.setAttribute("data-color-scheme", mode);
    const surface = win.getComputedStyle(card()).backgroundColor;
    check(`${mode} explanation and source labels have readable contrast`, contrast(win.getComputedStyle(card().querySelector(".dr-explain")).color, surface) >= 7
      && contrast(win.getComputedStyle(card().querySelector(".dr-sources > .dr-muted")).color, surface) >= 4.5);
    const role = win.getComputedStyle(card().querySelector(".dr-role"));
    check(`${mode} role label preserves strong contrast`, contrast(role.color, role.backgroundColor) >= 4.5);
    await shot(`reader-${mode}.png`);
  }
  if (rootTheme === null) doc.documentElement.removeAttribute("data-color-scheme"); else doc.documentElement.setAttribute("data-color-scheme", rootTheme);
  if (pdfTheme === null) s.overlay.pdfDoc.documentElement.removeAttribute("data-color-scheme"); else s.overlay.pdfDoc.documentElement.setAttribute("data-color-scheme", pdfTheme);
  more().click(); rail.detach();
  check("detaching rail removes its action menu and listeners", !menu());
  return { checks: E2E.result.steps.length };
};

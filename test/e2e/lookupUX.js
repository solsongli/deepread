/* Local citation/figure lookup in real Zotero DOM and PDF geometry; no model calls.
 * python3 -E test/build-lookup-fixture.py
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/lookup.pdf scripts/e2e.sh test/e2e/lookupUX.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead;
  D.prefs.set("cards.autoExplain", false);
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const app = s.pdfAdapter(); await app.prepareGeometry();
  const lookup = s.lookup, overlay = s.overlay;
  const para = { pageIndex: 0, paragraphIndex: 0, paragraphType: "text", paragraphText: "See [1] and Fig. 1 for the supporting experiment.", paragraphSummary: "核对实验依据",
    rects: [[50, 687, 370, 702]], points: [{ summary: "实验依据", translation: "参考文献 [1] 和图 1 给出了实验依据。" }] };
  const figure = { id: "figure_1", kind: "figure", number: "1", pageIndex: 0, bbox: [80, 267, 460, 558], title: "Measured performance", caption: "Figure 1: Measured performance." };
  s.data = { hierarchicalData: [{ pageIndex: 0, paragraphs: [para] }], contentList: [] };
  s.references = () => ({ list: [{ id: "ref_1", n: 1, label: "1", title: "A complete title for exact verification", authors: "Author", year: "2026", text: "Author. A complete title for exact verification. 2026." }], occurrences: new Map([["ref_1", [{}]]]) });
  s.figures = () => [figure];
  overlay.setData(s.data.hierarchicalData);
  await sleep(300);
  const chars = await lookup._pageChars(0);
  function pointFor(text) {
    let flat = "", slots = [];
    chars.forEach((c, i) => { const u = c.u ?? c.c ?? ""; for (const ch of u) { flat += ch; slots.push(i); } if (c.spaceAfter) { flat += " "; slots.push(i); } });
    const at = flat.indexOf(text); check(`real PDF contains ${text}`, at >= 0);
    const rect = chars[slots[at]].rect, geom = overlay._geometry(0);
    const pct = overlay._toPercent(geom, rect), bounds = geom.div.getBoundingClientRect();
    return { x: bounds.left + geom.div.clientLeft + (pct.left + pct.width / 2) * geom.div.clientWidth / 100,
      y: bounds.top + geom.div.clientTop + (pct.top + pct.height / 2) * geom.div.clientHeight / 100 };
  }
  const citePoint = pointFor("[1]"), figPoint = pointFor("Fig. 1");
  const p = overlay.pages.get(0)[0];
  overlay.hoverPara = p; overlay.trPara = p; overlay._drawHover(p);
  check("source translation is initially visible", !!overlay.pdfDoc.querySelector(".dr-translation"));
  const cite = await lookup.probe(0, citePoint.x, citePoint.y);
  check("real citation opens the matching reference", cite?.kind === "citation" && lookup.popover.textContent.includes("A complete title"));
  check("lookup exposes source instead of competing with translation", !overlay.pdfDoc.querySelector(".dr-translation") && overlay._suppressPara === p);
  check("lookup is a labelled keyboard-focusable dialog", lookup.popover.tabIndex === 0 && lookup.popover.getAttribute("role") === "dialog" && !!lookup.popover.getAttribute("aria-label"));
  lookup.popover.querySelector(".dr-lk-actions button").focus();
  lookup._scheduleHide(); await sleep(300);
  check("focused lookup survives pointer departure", !lookup.popover.hidden && lookup.popover.contains(lookup.readerDoc.activeElement));
  let prevented = false;
  lookup._onKey({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() {} });
  check("Escape closes the focused lookup", prevented && lookup.popover.hidden && lookup.current === null);
  lookup._onMove({ clientX: citePoint.x, clientY: citePoint.y, target: overlay._geometry(0).div });
  await sleep(320);
  check("Escape does not immediately reopen the same citation", lookup.popover.hidden);
  lookup._dismissed = null;
  const found = await lookup.probe(0, figPoint.x, figPoint.y);
  check("real figure reference opens its own preview", found?.kind === "figure" && lookup.popover.textContent.includes("Measured performance"));
  check("figure preview uses a drawn thumbnail", lookup.popover.querySelector("canvas")?.dataset.drawn === "1");
  const realRect = overlay._rectInReaderDoc.bind(overlay), anchor = realRect(0, lookup.current.rect);
  overlay._rectInReaderDoc = () => ({ ...anchor, frameLeft: anchor.left - 10, frameRight: anchor.left + 180, frameTop: anchor.top - 10, frameBottom: anchor.top + 180 });
  lookup._position(lookup.popover, lookup.current);
  const narrow = lookup.popover.getBoundingClientRect();
  check("narrow lookup stays within both frame edges", narrow.left >= anchor.left - 7 && narrow.right <= anchor.left + 177);
  check("short lookup stays within both vertical edges", narrow.top >= anchor.top - 7 && narrow.bottom <= anchor.top + 177);
  check("thumbnail shrinks inside a narrow popup", lookup.popover.querySelector("canvas").getBoundingClientRect().width <= lookup.popover.clientWidth);
  overlay._rectInReaderDoc = realRect;
  lookup._position(lookup.popover, lookup.current);
  const theme = lookup.readerDoc.documentElement.getAttribute("data-color-scheme");
  lookup.readerDoc.documentElement.setAttribute("data-color-scheme", "dark");
  check("lookup follows the dark reader theme", lookup.readerWin.getComputedStyle(lookup.popover).backgroundColor === "rgb(42, 45, 50)");
  if (theme === null) lookup.readerDoc.documentElement.removeAttribute("data-color-scheme"); else lookup.readerDoc.documentElement.setAttribute("data-color-scheme", theme);
  const pageChars = lookup._pageChars.bind(lookup);
  let resolve;
  lookup._pageChars = () => new Promise((r) => { resolve = r; });
  const late = lookup.probe(0, citePoint.x, citePoint.y);
  s.userState.modules = { lookup: false }; s.applyModules({ refresh: false });
  check("disabling lookup immediately closes its popup", lookup.popover.hidden);
  resolve(chars);
  check("late PDF lookup cannot reopen a disabled feature", await late === null && lookup.popover.hidden);
  lookup._pageChars = pageChars;
  s.userState.modules.lookup = true; s.applyModules({ refresh: false });
  await lookup.probe(0, citePoint.x, citePoint.y);
  check("lookup still works after re-enabling", lookup.current?.kind === "citation");
  const win = Zotero.getMainWindow();
  const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "reference-lookup.png"), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  lookup.hide();
  return { checks: E2E.result.steps.length };
};

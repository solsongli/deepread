/* Exercise real scrolling, zoom, inline math and split ownership in Zotero. */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function wait(fn, label) {
    for (let i = 0; i < 300; i++) {
      if (fn()) return;
      await sleep(30);
    }
    throw Error(label);
  }
  function check(name, ok) {
    E2E.result.steps.push({ name, ok: !!ok });
    if (!ok) throw Error(name);
  }
  await wait(() => Zotero.DeepRead?.Panes?.paneIDs?.chat, "plugin");
  const D = Zotero.DeepRead;
  D.prefs.set("parser.provider", "builtin");
  const pdf = await D.ParallelPDF.create(),
    italic = await pdf.embedFont("Times-Italic"),
    roman = await pdf.embedFont("Times-Roman");
  const path = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "scroll-fixture.pdf");
  for (let i = 0; i < 13; i++) {
    const page = pdf.addPage();
    page.setSize(480, 640);
    page.drawText("Section " + (i + 1), { x: 52, y: 565, size: 14, font: roman });
    page.drawText("The value is", { x: 52, y: 532, size: 11, font: roman });
    page.drawText("p", { x: 104, y: 532, size: 11, font: italic });
    page.drawText("k", { x: 110, y: 530, size: 8, font: italic });
    page.drawText(" in this experiment.", { x: 115, y: 532, size: 11, font: roman });
  }
  const bytes = await pdf.save();
  await IOUtils.write(path, Uint8Array.from(bytes));
  const a = await Zotero.Attachments.importFromFile({
    file: Zotero.File.pathToFile(path),
    libraryID: Zotero.Libraries.userLibraryID
  });
  const reader = await Zotero.Reader.open(a.id);
  await reader._initPromise;
  const s = D.Session.forReader(reader);
  await s.init();
  const internal = reader._internalReader.wrappedJSObject || reader._internalReader;
  const doc = s.overlay.readerDoc,
    button = doc.querySelector(".dr-parallel-button");
  const original = D.LLM.complete;
  let calls = 0,
    resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  D.LLM.complete = async (args) => {
    const rows = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
    calls++;
    await gate;
    return {
      content: JSON.stringify({
        translations: rows.map((row) => ({
          id: row.id,
          translation: "本次实验" + (row.source_text.match(/⟦D+\d+⟧/gu) || []).join(" ") + "。"
        }))
      })
    };
  };
  let c;
  try {
    button.click();
    await wait(() => s.comparison?.page?.units, "native first page");
    c = s.comparison;
    const n = c.native,
      left = n.left.pdfViewer,
      right = n.right.pdfViewer;
    check(
      "opening the native reader incurs no model requests",
      calls === 0 && internal._state.splitType === "vertical"
    );
    const translation = c.translateBook();
    await wait(() => calls > 0, "translation started");
    left.currentPageNumber = 5;
    await wait(
      () => right.currentPageNumber === 5 && n.pages.get(4)?.page?.units,
      "scroll during translation"
    );
    check(
      "Zotero navigation stays usable while translation is running",
      !!c.book && right.currentPageNumber === 5
    );
    resume();
    const result = await translation;
    await wait(
      () => c.pageIndex === 4 && c.target.stage.querySelector(".dr-parallel-text"),
      "new translations arrive in the visible native page"
    );
    await c.showPage(0);
    check("one action translates the whole paper", result && calls > 0);
    const before = calls;
    const scroll = (viewer, amount) => viewer.container.scrollBy(0, amount);
    const same = () => Math.abs(left.container.scrollTop - right.container.scrollTop) < 2;
    scroll(left, 95);
    await wait(() => same() && right.container.scrollTop > 60, "left to right scroll");
    check("both native panes scroll a fraction of a page", left.currentPageNumber === 1 && same());
    const rv = right.container;
    rv.dispatchEvent(new n.rightDoc.defaultView.WheelEvent("wheel", { deltaY: 300, bubbles: true }));
    scroll(right, Math.round(right.getPageView(0).div.clientHeight * 4.8));
    await wait(
      () => same() && c.pageIndex >= 4 && c.native.pages.get(c.pageIndex)?.page?.units,
      "scroll across cached pages"
    );
    const index = c.pageIndex;
    check(
      "scrolling the translation crosses multiple pages without navigation clicks",
      index >= 4 && calls === before
    );
    await wait(() => !!c.target.stage.querySelector("canvas[data-math-crop]"), "formula on later page");
    const atom = c.target.stage.querySelector("[role=math]"),
      bitmap = atom.querySelector("canvas"),
      css = c.surface.doc.defaultView;
    const measured = () => ({
      frame: atom.getBoundingClientRect(),
      bitmap: bitmap.getBoundingClientRect(),
      em:
        parseFloat(css.getComputedStyle(atom).fontSize) * parseFloat(c.target.stage.style.transform.slice(6))
    });
    const metric = measured();
    check(
      "an inline subscript has one graphic with a baseline-sized box",
      metric.frame.height <= metric.em * 1.5 &&
        Math.abs(metric.frame.width - metric.bitmap.width) < 0.1 &&
        atom.getAttribute("aria-label").includes("k") &&
        !atom.textContent.match(/_\{|\^\{/u)
    );
    const fraction = c.surface.doc.querySelector('link[href$="styles/paper.css"]');
    fraction.disabled = true;
    check(
      "losing the paper stylesheet cannot expose TeX or enlarge the bitmap",
      css.getComputedStyle(atom).display === "inline-block" &&
        Math.abs(measured().bitmap.width - metric.bitmap.width) < 1 &&
        atom.textContent === ""
    );
    fraction.disabled = false;
    right.currentScale = 2.8;
    await wait(
      () =>
        Math.abs(left.currentScale - right.currentScale) < 0.001 &&
        bitmap.width /
          Math.max(1, parseFloat(atom.style.width) * parseFloat(css.getComputedStyle(atom).fontSize)) >
          2.6,
      "sharp zoomed formula"
    );
    const large = measured();
    check(
      "high-resolution glyphs still fit the same em box",
      Math.abs(large.frame.height / large.em - metric.frame.height / metric.em) < 0.035 &&
        Math.abs(large.frame.width - large.bitmap.width) < 0.1 &&
        calls === before
    );
    const dims = c.surface.page;
    const htmlDoc = c.surface.doc,
      frag = htmlDoc.createDocumentFragment();
    frag.append("⟦D0⟧");
    const copied = D.ParallelInk.materialize(
      htmlDoc,
      frag,
      { tokens: [{ kind: "tex", id: "⟦D0⟧", display: "$p_k \\in [0,1]$" }] },
      dims,
      null,
      null
    );
    check(
      "OCR-only math uses native MathML with a true subscript",
      !!copied.querySelector("math msub") &&
        !copied.querySelector("annotation") &&
        !copied.textContent.includes("_")
    );
    await c.showPage(11);
    await wait(() => c.pageIndex === 11 && n.pages.size <= 5, "virtualized pages");
    check("only nearby translated surfaces stay resident", n.pages.size <= 5 && calls === before);
    const nativePage = left.currentPageNumber;
    c.close();
    await wait(() => !internal._state.splitType, "close split");
    check(
      "closing leaves the original PDF at the current page",
      !c.root && Math.abs(left.currentPageNumber - nativePage) <= 1
    );
    internal.toggleHorizontalSplit(true);
    await internal._secondaryView.initializedPromise;
    const previous = internal._secondaryView;
    button.click();
    await wait(() => c.native?.ready && c.page?.units, "reuse existing split");
    c.close();
    check(
      "an existing split is restored without replacing its reader",
      internal._state.splitType === "horizontal" && internal._secondaryView === previous
    );
    button.click();
    await wait(() => c.native?.ready && c.page?.units, "reopen");
    internal.disableSplitView();
    await wait(() => !c.root, "native unsplit");
    check(
      "Zotero can end comparison through its own split menu",
      !doc.querySelector(".dr-native-tools") && !internal._state.splitType
    );
    return { checks: E2E.result.steps.length, calls };
  } finally {
    resume();
    D.LLM.complete = original;
    if (c?.root) c.close(false);
  }
};

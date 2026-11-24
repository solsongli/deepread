/* Print the actual translated text and original artwork at the physical PDF size.
 * Gecko creates selectable text. pdf-lib preserves exact page boxes and collects pages.
 * License: AGPL-3.0-or-later */
(function () {
  let library;
  const element = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);

  async function create() {
    if (!library) {
      const scope = { setTimeout, clearTimeout, Uint8Array, ArrayBuffer };
      Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/pdf-lib/pdf-lib.min.js`, scope);
      library = scope.PDFLib;
    }
    return library.PDFDocument.create();
  }

  function withCanvases(doc, original) {
    const copy = doc.importNode(original, true);
    const canvases = [...copy.querySelectorAll("canvas")];
    [...original.querySelectorAll("canvas")].forEach((src, i) =>
      canvases[i].getContext("2d").drawImage(src, 0, 0)
    );
    return copy;
  }

  function sheetStyles(doc, url) {
    return new Promise((resolve, reject) => {
      const link = element(doc, "link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = resolve;
      link.onerror = () => reject(new Error("Could not load " + url));
      doc.head.append(link);
    });
  }

  async function snapshot(reader, frame) {
    const { page, target } = reader,
      doc = frame.contentDocument;
    doc.documentElement.lang = page.language === "zh" ? "zh-CN" : page.language;
    const csp = element(doc, "meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.content = "default-src 'none'; style-src 'unsafe-inline' chrome:; img-src data:; font-src chrome: data:";
    doc.head.append(csp);
    const sheets = [sheetStyles(doc, "chrome://deepread/content/styles/parallel.css"), DeepRead.PaperType.install(doc).sheet];
    if (target.stage.querySelector(".katex") || reader.extra.querySelector(".katex"))
      sheets.push(sheetStyles(doc, "chrome://deepread/content/lib/katex/katex.min.css"));
    const style = element(doc, "style");
    style.textContent = `@page {size:${page.width}pt ${page.height}pt;margin:0} html,body {margin:0;padding:0;color:#171717;background:white} * {print-color-adjust:exact}
      .sheet {position:relative;width:${page.width}pt;height:${page.height}pt;overflow:hidden;margin:0;break-inside:avoid}
      .dr-parallel-stage {transform:scale(1.3333333333)!important;transform-origin:0 0!important} .dr-paired {outline:none!important}
      .supplement {break-before:page;padding:24pt;font-size:11pt;line-height:1.55;overflow-wrap:anywhere} .supplement p {margin:.6em 0}
      .dr-parallel-line a {color:inherit;text-decoration:none} .dr-parallel-text[data-overflow] {overflow:hidden;scrollbar-width:none}`;
    doc.head.append(style);
    const sheet = element(doc, "div");
    sheet.className = "sheet";
    const stage = withCanvases(doc, target.stage);
    stage.classList.remove("dr-paired");
    for (const link of stage.querySelectorAll("a")) {
      const annotation = page.links?.[Number(link.dataset.sourceLink)];
      if (/^https?:\/\//i.test(annotation?.url || "")) link.href = annotation.url;
      else link.removeAttribute("href");
    }
    sheet.append(stage);
    doc.body.append(sheet);
    if (page.supplements?.length) {
      const section = element(doc, "section");
      section.className = "supplement";
      DeepRead.PaperType.apply(section, page.language);
      const heading = element(doc, "h3");
      heading.textContent = DeepRead.bilingual(
        `第 ${page.index + 1} 页 · 补充译文`,
        `Page ${page.index + 1} · Full passages`
      );
      section.append(heading);
      const canvas = reader.source.canvas,
        pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      for (const unit of page.supplements) {
        const paragraph = element(doc, "p");
        const translated = doc.importNode(
          reader.session.overlay._translationContent(unit, unit.translation, page.language),
          true
        );
        paragraph.append(DeepRead.ParallelInk.materialize(doc, translated, unit, page, canvas, pixels));
        section.append(paragraph);
      }
      doc.body.append(section);
    }
    await Promise.all(sheets);
    doc.documentElement.getBoundingClientRect();
    await doc.fonts.ready;
  }

  function restoreTextMapping(pdf, sourceText) {
    // Cairo can map a shared glyph to the Kangxi radical ⾼ instead of 高,
    // or to a presentation ligature. Recover only characters actually present
    // in the printed text. The font program and its visible glyphs stay intact.
    const { PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = library;
    const seen = new Set();
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const ref = obj.get(PDFName.of("ToUnicode"));
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const cmap = new TextDecoder().decode(decodePDFRawStream(stream).decode());
      const fixed = cmap.replace(/\d+ beginbfchar[\s\S]*?endbfchar/g, (table) =>
        table.replace(/(<[0-9a-f]+>\s+)<(2f[0-9a-f]{2}|fb0[0-6])>/gi, (pair, key, hex) => {
          const raw = String.fromCharCode(parseInt(hex, 16)),
            normalized = raw.normalize("NFKC");
          if (raw === normalized || sourceText.includes(raw) || !sourceText.includes(normalized)) return pair;
          const code = Array.from(normalized, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
          return key + "<" + code + ">";
        })
      );
      if (fixed !== cmap) pdf.context.assign(ref, pdf.context.flateStream(fixed));
    }
  }

  async function append(output, reader, signal) {
    const page = reader.page;
    const frame = element(reader.doc, "iframe");
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;left:-20000px;top:0;width:1000px;height:1200px;border:0;pointer-events:none";
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    frame.src = "about:blank";
    reader.doc.body.append(frame);
    const temp = PathUtils.join(PathUtils.tempDir, `deepread-page-${crypto.randomUUID()}.pdf`);
    try {
      await loaded;
      if (signal.aborted) return;
      await snapshot(reader, frame);
      if (signal.aborted) return;
      const settings = Cc["@mozilla.org/gfx/printsettings-service;1"]
        .getService(Ci.nsIPrintSettingsService)
        .createNewPrintSettings();
      Object.assign(settings, {
        printerName: "Mozilla Save to PDF",
        paperSizeUnit: Ci.nsIPrintSettings.kPaperSizeInches,
        paperWidth: page.width / 72,
        paperHeight: page.height / 72,
        outputFormat: Ci.nsIPrintSettings.kOutputFormatPDF,
        outputDestination: Ci.nsIPrintSettings.kOutputDestinationFile,
        toFileName: temp,
        printSilent: true,
        printBGImages: true,
        printBGColors: true,
        marginTop: 0,
        marginLeft: 0,
        marginBottom: 0,
        marginRight: 0,
        headerStrLeft: "",
        headerStrCenter: "",
        headerStrRight: "",
        footerStrLeft: "",
        footerStrCenter: "",
        footerStrRight: "",
        shrinkToFit: false,
        scaling: 1
      });
      const context =
        frame.browsingContext ||
        frame.contentWindow.browsingContext ||
        frame.contentWindow.docShell?.browsingContext;
      await context.print(settings);
      if (signal.aborted) return;
      const printed = await library.PDFDocument.load(Uint8Array.from(await IOUtils.read(temp)));
      restoreTextMapping(printed, reader.target.stage.textContent + reader.extra.textContent);
      const pages = await output.copyPages(printed, printed.getPageIndices());
      for (const result of pages) {
        // Cairo rounds the outer paper box to whole points. Keep the upper-left
        // anchor (including link coordinates) and trim only the outer rounding.
        const box = result.getMediaBox(),
          bottom = box.y + box.height - page.height;
        result.setMediaBox(box.x, bottom, page.width, page.height);
        result.setCropBox(box.x, bottom, page.width, page.height);
        output.addPage(result);
      }
    } finally {
      frame.remove();
      await IOUtils.remove(temp, { ignoreAbsent: true });
    }
  }
  DeepRead.ParallelPDF = { create, append };
})();

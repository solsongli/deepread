/* Facing-page translation in Zotero. Both sheets use the same PDF.js viewport,
 * original raster and scale. Only translated text frames are repainted.
 * License: AGPL-3.0-or-later */
(function () {
  const tr = (zh, en) => DeepRead.bilingual(zh, en);
  const h = (doc, tag, cls, text) => DeepRead.util.h(doc, tag, { class: cls }, text);
  const raw = (obj) => obj?.wrappedJSObject || obj;
  const slotFor = (page, language) => `page:${page}:${language}`;
  const PLAN = DeepRead.ParallelPage;

  const { project, orientation, materialize } = DeepRead.ParallelInk;

  // Sample the paper immediately outside a source line. Keep irregular picture
  // backgrounds intact; those units are available in the page's transcript.
  function paperColor(pixels, r, kx, ky) {
    const colors = new Map();
    for (const dy of [-0.6, r.height + 0.6]) for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const x = Math.max(0, Math.min(pixels.width - 1, Math.round((r.left + r.width * fraction) * kx)));
      const y = Math.max(0, Math.min(pixels.height - 1, Math.round((r.top + dy) * ky)));
      const index = 4 * (y * pixels.width + x);
      const rgb = pixels.data.slice(index, index + 3);
      const key = Array.from(rgb, (n) => n >> 4).join(",");
      if (!colors.has(key)) colors.set(key, { count: 0, rgb });
      colors.get(key).count++;
    }
    const best = [...colors.values()].sort((a, b) => b.count - a.count)[0];
    return best.count >= 7 ? best.rgb : null;
  }

  function makeSheet(doc, label) {
    const column = h(doc, "div", "dr-parallel-column");
    const element = h(doc, "div", "dr-parallel-sheet");
    const stage = h(doc, "div", "dr-parallel-stage");
    const canvas = h(doc, "canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", label);
    stage.append(canvas); element.append(stage);
    column.append(h(doc, "div", "dr-parallel-label", label), element);
    return { column, element, stage, canvas };
  }

  DeepRead.ParallelReader = class ParallelReader {
    constructor(session) { this.session = session; this.zoom = 1; }

    async open(trigger) {
      if (this.root) { this.close(); return; }
      await this.session.init();
      if (this.root || !this.session.overlay.attached || this.session.status === "running") return;
      const { readerDoc: doc, app } = this.session.overlay;
      this.doc = doc; this.trigger = trigger;
      DeepRead.util.injectStylesheet(doc, "chrome://deepread/content/styles/parallel.css", "deepread-parallel-css");
      const root = this.root = h(doc, "dialog", "deepread-parallel");
      root.setAttribute("aria-label", tr("原版 1:1 对照", "Original-layout translation"));
      const bar = h(doc, "div", "dr-parallel-bar");
      const button = (parent, cls, label, action) => {
        const el = h(doc, "button", cls, label); el.type = "button";
        el.addEventListener("click", action); parent.append(el); return el;
      };
      this.back = button(bar, "dr-parallel-close", tr("返回论文", "Back to paper"), () => this.close());
      bar.append(h(doc, "strong", "", tr("原版对照", "Parallel reading")));
      const nav = h(doc, "div", "dr-parallel-nav"); bar.append(nav);
      this.previous = button(nav, "dr-parallel-prev", "‹", () => this.showPage(this.pageIndex - 1));
      this.previous.setAttribute("aria-label", tr("上一页", "Previous page"));
      this.number = h(doc, "input", "dr-parallel-page-number"); this.number.type = "number"; this.number.min = "1";
      this.number.setAttribute("aria-label", tr("页码", "Page number"));
      this.count = app.pdfDocument.numPages; this.number.max = String(this.count);
      this.number.addEventListener("change", () => {
        const n = this.number.valueAsNumber;
        if (Number.isInteger(n) && n >= 1 && n <= this.count && n !== this.pageIndex + 1) this.showPage(n - 1);
        else this.number.value = String(this.pageIndex + 1);
      });
      nav.append(this.number, h(doc, "span", "", `/ ${this.count}`));
      this.next = button(nav, "dr-parallel-next", "›", () => this.showPage(this.pageIndex + 1));
      this.next.setAttribute("aria-label", tr("下一页", "Next page"));
      const zoom = h(doc, "div", "dr-parallel-nav"); bar.append(zoom);
      this.minus = button(zoom, "", "−", () => this.changeZoom(-0.25)); this.minus.setAttribute("aria-label", tr("缩小两页", "Zoom out both pages"));
      this.fit = button(zoom, "", tr("适宽", "Fit width"), () => { this.zoom = 1; this.resize(); });
      this.plus = button(zoom, "", "+", () => this.changeZoom(0.25)); this.plus.setAttribute("aria-label", tr("放大两页", "Zoom in both pages"));
      this.swap = button(bar, "dr-parallel-swap", tr("查看原文", "Show original"), () => {
        root.classList.toggle("dr-show-source"); this.resize();
      });
      this.translateButton = button(bar, "dr-parallel-translate", tr("翻译本页", "Translate page"), () => this.translatePage());
      this.bookButton = button(bar, "dr-parallel-book", tr("翻译全文", "Translate all pages"), () => {
        if (this.exportJob) this.exportJob.abort(); else this.translateBook();
      });
      this.bookButton.disabled = true;
      this.exportControl = h(doc, "select", "dr-parallel-export");
      this.exportControl.setAttribute("aria-label", tr("保存译文 PDF", "Save translated PDF"));
      for (const [value, label] of [
        ["", tr("保存 PDF…", "Save PDF…")],
        ["page", tr("本页译文", "Current translated page")],
        ["all", tr("全文译文", "Translated document")]
      ]) {
        const option = h(doc, "option", "", label);
        option.value = value;
        this.exportControl.append(option);
      }
      this.exportControl.disabled = true;
      this.exportControl.addEventListener("change", () => {
        const scope = this.exportControl.value;
        this.exportControl.value = "";
        if (scope)
          this.savePDF(scope).catch((err) => {
            if (this.root) this.status.textContent = DeepRead.util.formatError(err);
          });
      });
      bar.append(this.exportControl);
      this.status = h(doc, "div", "dr-parallel-status"); this.status.setAttribute("role", "status");
      this.scroll = h(doc, "div", "dr-parallel-scroll"); this.scroll.tabIndex = 0;
      this.sheets = h(doc, "div", "dr-parallel-sheets"); this.scroll.append(this.sheets);
      this.extra = h(doc, "div", "dr-parallel-extra"); this.scroll.append(this.extra);
      root.append(bar, this.status, this.scroll); doc.body.append(root);
      root.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
      root.addEventListener('click', event => {
        const link = event.target.closest?.('[data-source-link]');
        if (!link) return;
        event.preventDefault();
        this.openReference(Number(link.dataset.sourceLink)).catch(error => { if (this.root) this.status.textContent = DeepRead.util.formatError(error); });
      });
      root.showModal(); this.back.focus();
      this.observer = new doc.defaultView.ResizeObserver(() => this.resize()); this.observer.observe(this.scroll);
      this.originalPage = Math.max(0, (app.pdfViewer.currentPageNumber || 1) - 1);
      this.session._emit("comparison");
      await this.showPage(this.originalPage);
    }

    close(navigate = true) {
      if (!this.root) return;
      this.controller?.abort(); this.renderTask?.cancel(); this.renderTask = null;
      this.book?.abort(); this.book = null;
      this.exportJob?.abort(); this.exportJob=null;
      this.observer?.disconnect(); this.root.close(); this.root.remove(); this.root = null;
      this.doc.getElementById("deepread-parallel-css")?.remove();
      for (const sheet of [this.source, this.target]) if (sheet) sheet.canvas.width = sheet.canvas.height = 0;
      this.sheets.replaceChildren(); this.extra.replaceChildren();
      this.page = null; this.source = null; this.target = null;
      const session = this.session;
      if (navigate && this.pageIndex !== this.originalPage) {
        session.reader.navigate({ pageIndex: this.pageIndex }).catch((err) => DeepRead.log("comparison navigation", String(err)));
      }
      this.trigger?.focus({ preventScroll: true }); this.trigger = null;
      session._emit("comparison");
    }

    changeZoom(amount) { this.zoom = Math.min(3, Math.max(0.5, this.zoom + amount)); this.resize(); }

    resize() {
      if (!this.root || !this.page || !this.source) return;
      const width = this.scroll.clientWidth;
      if (!width) return;
      const single = width < 740;
      this.root.classList.toggle("dr-single", single);
      this.swap.hidden = !single;
      this.swap.textContent = this.root.classList.contains("dr-show-source") ? tr("查看译文", "Show translation") : tr("查看原文", "Show original");
      const available = width - 24 - (single ? 0 : 12);
      const scale = Math.max(0.05, available / (single ? 1 : 2) / this.page.width * this.zoom);
      for (const sheet of [this.source, this.target]) {
        sheet.element.style.width = `${this.page.width * scale}px`; sheet.element.style.height = `${this.page.height * scale}px`;
        sheet.stage.style.transform = `scale(${scale})`;
      }
      this.minus.disabled = this.zoom <= 0.5; this.plus.disabled = this.zoom >= 3;
    }

    alive(token) { return this.root && this.controller === token && !token.signal.aborted; }

    async showPage(index, exportJob = null) {
      if (!this.root || this.book || (this.exportJob && this.exportJob!==exportJob) || !Number.isInteger(index) || index < 0 || index >= this.count) return;
      this.controller?.abort(); this.renderTask?.cancel(); this.renderTask = null;
      const token = this.controller = new AbortController();
      this.pageIndex = index; this.number.value = String(index + 1);
      this.previous.disabled = index === 0; this.next.disabled = index + 1 === this.count;
      this.page = null; this.source = null; this.target = null;
      this.exportControl.disabled=true;
      this.sheets.replaceChildren(); this.extra.replaceChildren(); this.scroll.scrollTop = 0;
      this.bookButton.disabled = true; this.translateButton.hidden = true; this.status.textContent = tr("正在绘制页面…", "Rendering page…");
      try {
        const overlay = this.session.overlay, win = overlay.pdfWin, doc = overlay.app.pdfDocument;
        const pdfPage = raw(await doc.getPage(index + 1));
        if (!this.alive(token)) return;
        const rotation = ((pdfPage.rotate || 0) + (overlay.app.pdfViewer.pagesRotation || 0)) % 360;
        const viewportAt = (scale) => raw(pdfPage.getViewport(Components.utils.cloneInto({ scale, rotation }, win)));
        const viewport = viewportAt(1);
        const width = viewport.width, height = viewport.height;
        const rasterScale = Math.min(2, 4096 / Math.max(width, height), Math.sqrt(4500000 / (width * height)));
        const bitmap = h(overlay.pdfDoc, "canvas"); bitmap.width = Math.max(1, Math.ceil(width * rasterScale)); bitmap.height = Math.max(1, Math.ceil(height * rasterScale));
        const params = raw(Components.utils.createObjectIn(win));
        params.canvasContext = raw(bitmap.getContext("2d")); params.viewport = viewportAt(rasterScale);
        const task = this.renderTask = raw(pdfPage.render(params));
        const annotationsTask = pdfPage.getAnnotations ? Promise.resolve(pdfPage.getAnnotations(
          Components.utils.cloneInto({ intent:'display' },win))).catch(() => []) : [];
        const [pageData, annotations] = await Promise.all([this.session.pdfAdapter().pdfDocument.getPageData({ pageIndex: index }),
          annotationsTask, task.promise]);
        if (!this.alive(token)) return;
        this.renderTask = null;
        const page = this.page = { index, width, height, transform: Array.from(viewport.transform), view: Array.from(pdfPage.view),
          chars: pageData.chars || [], fingerprint: Array.from(doc.fingerprints || []).join("/"), language: DeepRead.prefs.language() };
        page.links=JSON.parse(win.JSON.stringify(annotations)).filter(a=>a.subtype==='Link' && a.rect && (a.dest || /^https?:\/\//i.test(a.url || '')));
        this.source = makeSheet(this.doc, tr("原文", "Original")); this.target = makeSheet(this.doc, tr("译文", "Translation"));
        for (const sheet of [this.source, this.target]) {
          sheet.stage.style.width = `${width}px`; sheet.stage.style.height = `${height}px`;
          sheet.canvas.width = bitmap.width; sheet.canvas.height = bitmap.height;
          sheet.canvas.getContext("2d").drawImage(bitmap, 0, 0);
        }
        bitmap.width = bitmap.height = 0;
        this.sheets.replaceChildren(this.source.column, this.target.column); this.resize();
        const provider = DeepRead.prefs.parserConfig().provider;
        if (this.parsed?.fingerprint !== page.fingerprint) this.parsed = null;
        if (provider !== "builtin" && !this.session.data?.contentList && this.parsed?.provider !== provider) {
          const stored = await DeepRead.Store.comparisonData(this.session.key, page.fingerprint, `parse:${provider}`);
          if (!this.alive(token)) return;
          if (stored) this.parsed = { provider, items: stored, fingerprint: page.fingerprint };
        }
        page.saved = await DeepRead.Store.comparisonData(this.session.key, page.fingerprint, slotFor(index, page.language));
        if (!this.alive(token)) return;
        this.prepareUnits(page); this.paint();
      }
      catch (error) { if (this.alive(token)) this.status.textContent = tr("此页无法显示：", "Could not display page: ") + DeepRead.util.formatError(error); }
    }

    async openReference(index) {
      const old = this.page,
        link = old?.links?.[index];
      if (!link || this.book || this.exportJob) return;
      if (/^https?:\/\//i.test(link.url || "")) {
        Zotero.launchURL(link.url);
        return;
      }
      const { app, pdfWin } = this.session.overlay;
      const pdf = app.pdfDocument;
      const dest = typeof link.dest === "string" ? raw(await pdf.getDestination(link.dest)) : link.dest;
      if (!dest?.length) return;
      const number = Number.isInteger(dest[0])
        ? dest[0]
        : await pdf.getPageIndex(Components.utils.cloneInto({ num: dest[0].num, gen: dest[0].gen }, pdfWin));
      if (this.root && this.page === old) await this.showPage(number);
    }

    needsParse() {
      const provider = DeepRead.prefs.parserConfig().provider;
      return provider !== "builtin" && !this.session.data?.contentList?.length && !this.session.hasResults && this.parsed?.provider !== provider;
    }

    prepareUnits(page) {
      const s = this.session;
      let source = s.data?.contentList;
      if (!source?.length && this.parsed?.provider === DeepRead.prefs.parserConfig().provider) source = this.parsed.items;
      const paragraphs = (s.data?.hierarchicalData?.find((p) => p.pageIndex === page.index)?.paragraphs || []).map((p) => ({ ...p, pageIndex: page.index }));
      let items = [];
      if (source?.length) items = source.filter((p) => p.page_idx === page.index);
      else if (!paragraphs.length) items = DeepRead.TextLayerParser.buildContentList([{ pageIndex: page.index, viewBox: page.view, chars: page.chars }]);
      page.units = PLAN.plan({ paragraphs, items, chars: page.chars, view: page.view, language: page.language,
        reuse: (!s.data?.language || s.data.language === page.language), continuationFor: (p) => s.continuationFor(p) });
      page.context = PLAN.interruptedContext(source?.length ? source : items, page.index);
      page.localItems = source?.length ? null : items;
      PLAN.hydrate(page.units, page.saved);
    }

    async parseDocument(page, signal) {
      if (!this.needsParse()) return;
      const session = this.session;
      const provider = DeepRead.prefs.parserConfig().provider;
      const path = await session.item.getFilePathAsync();
      if (signal.aborted) return;
      // The parser empties its output directory. Use a private working directory
      // so that cancellation never overwrites existing MinerU or newer results.
      const scratch = `${session.key}-comparison-${crypto.randomUUID()}`;
      const scratchPath = PathUtils.join(DeepRead.Store.resultRoot(), scratch);
      let parsed;
      try {
        parsed = await DeepRead.Parser.parsePDF({ filePath: path, attachmentKey: scratch, pdfApp: session.pdfAdapter(), signal,
          onStatus: (progress) => { if (!signal.aborted) this.status.textContent = progress.message; } });
      }
      finally { await IOUtils.remove(scratchPath, { recursive: true, ignoreAbsent: true }); }
      if (signal.aborted) return;
      const items = parsed.contentList.map(({ id, page_idx, type, sub_type, text_level, bbox, text, list_items, image_caption, table_caption, chart_caption }) =>
        ({ id, page_idx, type, sub_type, text_level, bbox, text, list_items, image_caption, table_caption, chart_caption }));
      this.parsed = { provider, items, fingerprint: page.fingerprint };
      // A temporary service failure can fall back to built-in parsing. Retry the configured
      // service next time rather than marking its OCR result as permanently cached.
      if (!parsed.fallback) {
        await DeepRead.Store.saveComparisonData(session.key, page.fingerprint, `parse:${provider}`, items);
        session.hasComparisonCache = !!page.fingerprint;
      }
    }

    async translateUnits(page, signal) {
      if (!page.units.some((u) => !u.translation)) return;
      if (!DeepRead.LLM.isConfigured()) throw new Error(DeepRead.t("error.noLLM"));
      if (page.localItems?.length && this.count > 1) {
        const pdf = this.session.pdfAdapter().pdfDocument;
        const neighbours = [page.index - 1, page.index + 1].filter((index) => index >= 0 && index < this.count);
        const edges = await Promise.all(neighbours.map(async (index) => {
          const info = await pdf.getPageData({ pageIndex: index });
          return DeepRead.TextLayerParser.buildContentList([{ pageIndex: index, viewBox: info.viewBox, chars: info.chars }]);
        }));
        if (signal.aborted) return;
        const ordered = [...page.localItems, ...edges.flat()].sort((a, b) => a.page_idx - b.page_idx);
        page.context = PLAN.interruptedContext(ordered, page.index);
      }
      const units = page.units.map((unit) => ({ ...unit }));
      await PLAN.translate(units, { language: page.language, signal, context: page.context, request: (args) => DeepRead.LLM.complete(args) });
      if (signal.aborted) return;
      const saved = PLAN.records(units);
      await DeepRead.Store.saveComparisonData(this.session.key, page.fingerprint, slotFor(page.index, page.language), saved);
      if (signal.aborted) return;
      page.units = units;
      page.saved = saved;
      this.session.hasComparisonCache = !!page.fingerprint;
    }

    async translatePage() {
      const page = this.page, token = this.controller;
      if (!page || !this.alive(token) || page.busy || this.book || this.exportJob) return;
      page.busy = true; this.translateButton.disabled = this.bookButton.disabled = this.exportControl.disabled = true;
      try {
        if (this.needsParse()) {
          if (!DeepRead.LLM.isConfigured()) throw new Error(DeepRead.t("error.noLLM"));
          await this.parseDocument(page, token.signal);
          if (!this.alive(token)) return;
          this.prepareUnits(page);
        }
        this.status.textContent = tr("正在翻译本页…", "Translating this page…");
        await this.translateUnits(page, token.signal);
        if (this.alive(token)) this.paint();
      }
      catch (error) { if (this.alive(token)) this.status.textContent = tr("本页翻译失败：", "Page translation failed: ") + DeepRead.util.formatError(error); }
      finally {
        page.busy = false;
        if (this.alive(token)) {
          this.translateButton.disabled = this.bookButton.disabled = false;
          this.refreshExport();
        }
      }
    }

    async translateBook() {
      if (this.book) { this.book.abort(); return; }
      const current = this.page;
      if (!current || current.busy || !this.root || this.exportJob) return;
      const token = this.book = new AbortController();
      const signal = token.signal;
      this.bookButton.textContent = tr("停止翻译", "Stop translation");
      this.exportControl.disabled=true;
      this.number.disabled = this.previous.disabled = this.next.disabled = this.translateButton.disabled = true;
      let visited = 0, originals = 0;
      try {
        if (this.needsParse()) {
          if (!DeepRead.LLM.isConfigured()) throw new Error(DeepRead.t("error.noLLM"));
          await this.parseDocument(current, signal);
          if (signal.aborted) return;
          this.prepareUnits(current);
        }
        const adapter = this.session.pdfAdapter();
        for (let index = 0; index < this.count; index++) {
          if (signal.aborted) return;
          this.status.textContent = tr(`全文翻译 · 第 ${index + 1}/${this.count} 页`, `Translating page ${index + 1} of ${this.count}`);
          let page = current;
          if (index !== current.index) {
            const [geometry, data, saved] = await Promise.all([adapter.pdfDocument.getPage(index + 1),
              adapter.pdfDocument.getPageData({ pageIndex: index }), DeepRead.Store.comparisonData(this.session.key, current.fingerprint, slotFor(index, current.language))]);
            if (signal.aborted) return;
            page = { index, language: current.language, fingerprint: current.fingerprint, view: geometry.view, chars: data.chars || [], saved };
            this.prepareUnits(page);
          }
          await this.translateUnits(page, signal);
          if (signal.aborted) return;
          visited++;
          if (!page.units.length) originals++;
          if (page === current) this.paint();
        }
        this.status.textContent = tr(`已处理 ${visited} 页`, `Processed ${visited} pages`) + (originals ? tr(`，其中 ${originals} 页保留原图`, ` · ${originals} original-only pages`) : "");
      }
      catch (error) {
        if (!signal.aborted && this.root) this.status.textContent = tr(`第 ${visited + 1} 页未完成：`, `Page ${visited + 1} failed: `) + DeepRead.util.formatError(error);
      }
      finally {
        if (this.book === token) {
          this.book = null; this.bookButton.textContent = tr("翻译全文", "Translate all pages");
          this.translateButton.disabled = this.number.disabled = false;
          this.previous.disabled = current.index === 0; this.next.disabled = current.index + 1 === this.count;
          this.refreshExport();
          if (signal.aborted) this.status.textContent = tr(`已停止，已处理 ${visited} 页`, `Stopped after processing ${visited} pages`);
        }
      }
    }

    refreshExport() {
      const units = this.page?.units;
      this.exportControl.disabled =
        !units ||
        !!this.book ||
        !!this.exportJob ||
        !!this.page?.busy ||
        this.needsParse() ||
        units.some((u) => !u.translation);
    }

    async savePDF(scope = "page", path) {
      const current = this.page;
      if (!current?.units || current.busy || this.book || this.exportJob || !this.root) return false;
      const token = (this.exportJob = new AbortController()),
        signal = token.signal,
        start = this.pageIndex;
      const scroll = { top: this.scroll.scrollTop, left: this.scroll.scrollLeft };
      let tmpPath,
        message = "";
      try {
        if (!path) {
          const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
          const picker = new FilePicker();
          picker.init(
            this.session.reader._window || Zotero.getMainWindow(),
            tr("保存译文 PDF", "Save translated PDF"),
            picker.modeSave
          );
          const name = (this.session.item.attachmentFilename || "paper").replace(/\.pdf$/i, "");
          picker.defaultString = `${name}-${current.language}${scope === "all" ? "" : `-p${start + 1}`}.pdf`;
          picker.defaultExtension = "pdf";
          picker.appendFilter("PDF", "*.pdf");
          const result = await picker.show();
          if (result !== picker.returnOK && result !== picker.returnReplace) return false;
          path = picker.file;
        }
        const source = await this.session.item.getFilePathAsync();
        if (source && Zotero.File.pathToFile(source).equals(Zotero.File.pathToFile(path)))
          throw new Error(
            tr("请选择新的文件名，以保留原论文。", "Choose a new file name to keep the source PDF.")
          );
        if (signal.aborted) return false;
        this.exportControl.disabled = true;
        this.bookButton.textContent = tr("停止导出", "Stop export");
        const pdf = await DeepRead.ParallelPDF.create();
        pdf.setTitle((this.session.item.attachmentFilename || "DeepRead") + ` · ${current.language}`);
        const first = scope === "all" ? 0 : start,
          last = scope === "all" ? this.count - 1 : start;
        for (let i = first; i <= last; i++) {
          if (signal.aborted) return false;
          if (this.pageIndex !== i) await this.showPage(i, token);
          if (signal.aborted) return false;
          if (!this.page?.units) throw new Error(this.status.textContent);
          if (this.needsParse() || this.page.units.some((u) => !u.translation))
            throw new Error(
              tr(
                `第 ${i + 1} 页还有待译内容，请先翻译再保存。`,
                `Page ${i + 1} has untranslated content. Translate it before saving.`
              )
            );
          this.number.disabled =
            this.previous.disabled =
            this.next.disabled =
            this.translateButton.disabled =
              true;
          this.bookButton.disabled = false;
          this.status.textContent = tr(`正在保存第 ${i + 1} 页…`, `Saving page ${i + 1}…`);
          await DeepRead.ParallelPDF.append(pdf, this, signal);
        }
        if (signal.aborted) return false;
        const bytes = await pdf.save();
        if (signal.aborted) return false;
        tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
        await IOUtils.write(path, Uint8Array.from(bytes), { tmpPath });
        message = tr("已保存译文 PDF", "Translated PDF saved");
        return true;
      } finally {
        if (tmpPath) await IOUtils.remove(tmpPath, { ignoreAbsent: true });
        if (this.exportJob === token) {
          if (this.pageIndex !== start) await this.showPage(start, token);
          if (this.exportJob === token) {
            this.exportJob = null;
            this.bookButton.textContent = tr("翻译全文", "Translate all pages");
            this.number.disabled = false;
            this.previous.disabled = start === 0;
            this.next.disabled = start + 1 === this.count;
            this.translateButton.disabled = false;
            this.refreshExport();
            this.scroll.scrollTop = scroll.top;
            this.scroll.scrollLeft = scroll.left;
            if (message || signal.aborted) this.status.textContent = message || tr("已停止导出", "Export stopped");
          }
        }
      }
    }

    paint() {
      const page = this.page, canvas = this.target.canvas;
      const ctx = canvas.getContext("2d"); ctx.drawImage(this.source.canvas, 0, 0);
      this.source.stage.replaceChildren(this.source.canvas);
      this.target.stage.replaceChildren(canvas); this.extra.replaceChildren();
      const kx = canvas.width / page.width, ky = canvas.height / page.height;
      const pixels = page.units.some((u) => u.translation) ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
      const notes = [], hdoc = this.doc;
      page.supplements=[];
      for (const u of page.units) {
        if (!u.translation) continue;
        const rects = u.placed ? u.masks.map((r) => project(r, page.transform)) : [];
        const colors = rects.map((r) => paperColor(pixels, r, kx, ky));
        const originalFragment = hdoc.importNode(this.session.overlay._translationContent(u, u.translation), true);
        const fragment = materialize(hdoc,originalFragment,u,page,this.source.canvas,pixels);
        if (!rects.length || colors.some((c) => !c)) {
          notes.push([u, fragment]); page.supplements.push(u); continue;
        }
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]; ctx.fillStyle = `rgb(${colors[i].join(",")})`;
          ctx.fillRect(Math.floor(r.left * kx), Math.floor(r.top * ky), Math.ceil((r.left + r.width) * kx) - Math.floor(r.left * kx), Math.ceil((r.top + r.height) * ky) - Math.floor(r.top * ky));
        }
        if (u.markerRect) {
          const m=project(u.markerRect,page.transform), x=Math.max(0,Math.floor(m.left*kx)-1), y=Math.max(0,Math.floor(m.top*ky)-1);
          const w=Math.ceil((m.left+m.width)*kx)-x+1, ht=Math.ceil((m.top+m.height)*ky)-y+1;
          ctx.drawImage(this.source.canvas,x,y,w,ht,x,y,w,ht);
        }
        const r = project(u.rect, page.transform);
        const block = h(hdoc, "div", "dr-parallel-text");
        // Rotate the translated line with the source's writing direction, including
        // PDF /Rotate and the reader's own rotation. The source canvas uses this viewport too.
        const angle = orientation(u,page);
        block.style.transformOrigin = "0 0";
        block.style.transform = `rotate(${angle * 90}deg)`;
        block.style.left = `${r.left + (angle === 1 || angle === 2 ? r.width : 0)}px`;
        block.style.top = `${r.top + (angle === 2 || angle === 3 ? r.height : 0)}px`;
        block.style.width = `${angle % 2 ? r.height : r.width}px`;
        block.style.height = `${(angle % 2 ? r.width : r.height) + (angle===0 && !u.title ? u.clearance || 0 : 0)}px`;
        if (colors[0][0] * 0.21 + colors[0][1] * 0.72 + colors[0][2] * 0.07 < 115) block.style.color = "white";
        if (u.title && u.boldTitle) block.classList.add("dr-parallel-title");
        if (u.sans) block.classList.add('dr-parallel-sans');
        if (u.allItalic) block.style.fontStyle='italic';
        this.target.stage.append(block);
        DeepRead.ParallelTypeset.draw(block, u, fragment, u.size * Math.hypot(page.transform[0], page.transform[1]));
        if (block.dataset.overflow) page.supplements.push(u);
        this.pair(u,block,false);
      }
      if (notes.length) {
        const detail = h(hdoc, "details", "dr-parallel-unplaced"); detail.open = true;
        detail.append(h(hdoc, "summary", "", tr(`单独显示的译文（${notes.length}）`, `Translations outside the page (${notes.length})`)));
        for (const [u, frag] of notes) {
          const row = h(hdoc, "div", "dr-parallel-passage"); row.append(h(hdoc, "div", "", u.source), frag); detail.append(row);
          this.pair(u,row,true);
        }
        this.extra.append(detail);
      }
      const total = page.units.length, translated = page.units.filter((u) => u.translation).length;
      this.refreshExport();
      const parse = this.needsParse() && (!translated || translated < total);
      this.translateButton.hidden = translated === total && !parse;
      this.translateButton.disabled = !!this.book || !!this.exportJob; this.bookButton.disabled = false;
      this.translateButton.textContent = parse ? tr("解析文档并翻译本页", "Parse PDF and translate page") : tr("翻译本页", "Translate page");
      this.status.textContent = parse ? tr("将使用已配置的解析服务处理整份 PDF，再翻译本页。", "Your configured parser will process the PDF before this page is translated.")
        : total ? tr(`第 ${page.index + 1} 页 · 原位 ${translated-notes.length}/${total} 处`, `Page ${page.index + 1} · ${translated-notes.length}/${total} in place`)
          + (notes.length ? tr(` · 页下 ${notes.length} 处`, ` · ${notes.length} below`) : '')
          + (page.supplements.length>notes.length ? tr(` · 段内滚动 ${page.supplements.length-notes.length} 处`, ` · ${page.supplements.length-notes.length} scrollable`) : '')
          + (total>translated ? tr(` · 待译 ${total-translated} 处`, ` · ${total-translated} pending`) : '')
        : tr("本页保留原图。扫描正文需要可用的 OCR 解析结果。", "Original page shown. Scanned text needs OCR results.");
    }

    pair(unit, target, below) {
      if (!unit.rect) return;
      const r = project(unit.rect, this.page.transform),
        hit = h(this.doc, "button", "dr-parallel-hit");
      hit.setAttribute(
        "aria-label",
        tr("查看对应译文", "Show corresponding translation") + " · " + unit.source.slice(0, 64)
      );
      hit.type = "button";
      for (const [key, v] of Object.entries(r)) hit.style[key] = `${v}px`;
      this.source.stage.append(hit);
      const highlight = (on) => {
        hit.classList.toggle("dr-paired", on);
        target.classList.toggle("dr-paired", on);
      };
      for (const el of [hit, target]) {
        el.addEventListener("pointerenter", () => highlight(true));
        el.addEventListener("pointerleave", () => highlight(false));
        el.addEventListener("focusin", () => highlight(true));
        el.addEventListener("focusout", () => highlight(false));
      }
      hit.addEventListener("click", () => {
        if (this.root.classList.contains("dr-single")) {
          this.root.classList.remove("dr-show-source");
          this.resize();
        }
        if (below) {
          target.closest("details").open = true;
          target.scrollIntoView({ block: "center" });
        }
        if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        highlight(true);
      });
    }
  };
})();

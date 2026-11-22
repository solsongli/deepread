/* Facing-page translation in Zotero. Both sheets use the same PDF.js viewport,
 * original raster and scale. Only translated text frames are repainted.
 * License: AGPL-3.0-or-later */
(function () {
  const tr = (zh, en) => DeepRead.bilingual(zh, en);
  const h = (doc, tag, cls, text) => DeepRead.util.h(doc, tag, { class: cls }, text);
  const raw = (obj) => obj?.wrappedJSObject || obj;
  const slotFor = (page, language) => `page:${page}:${language}`;
  const PLAN = DeepRead.ParallelPage;

  function project(rect, t) {
    const [a, b, c, d, e, f] = t;
    const x1 = a * rect[0] + c * rect[1] + e, x2 = a * rect[2] + c * rect[3] + e;
    const y1 = b * rect[0] + d * rect[1] + f, y2 = b * rect[2] + d * rect[3] + f;
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

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
      this.bookButton = button(bar, "dr-parallel-book", tr("翻译全文", "Translate all pages"), () => this.translateBook());
      this.bookButton.disabled = true;
      this.status = h(doc, "div", "dr-parallel-status"); this.status.setAttribute("role", "status");
      this.scroll = h(doc, "div", "dr-parallel-scroll"); this.scroll.tabIndex = 0;
      this.sheets = h(doc, "div", "dr-parallel-sheets"); this.scroll.append(this.sheets);
      this.extra = h(doc, "div", "dr-parallel-extra"); this.scroll.append(this.extra);
      root.append(bar, this.status, this.scroll); doc.body.append(root);
      root.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
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

    async showPage(index) {
      if (!this.root || this.book || !Number.isInteger(index) || index < 0 || index >= this.count) return;
      this.controller?.abort(); this.renderTask?.cancel(); this.renderTask = null;
      const token = this.controller = new AbortController();
      this.pageIndex = index; this.number.value = String(index + 1);
      this.previous.disabled = index === 0; this.next.disabled = index + 1 === this.count;
      this.page = null; this.source = null; this.target = null;
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
        const [pageData] = await Promise.all([this.session.pdfAdapter().pdfDocument.getPageData({ pageIndex: index }), task.promise]);
        if (!this.alive(token)) return;
        this.renderTask = null;
        const page = this.page = { index, width, height, transform: Array.from(viewport.transform), view: Array.from(pdfPage.view),
          chars: pageData.chars || [], fingerprint: Array.from(doc.fingerprints || []).join("/"), language: DeepRead.prefs.language() };
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
      page.units = PLAN.plan({ paragraphs, items, chars: page.chars, view: page.view,
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
      if (!page || !this.alive(token) || page.busy || this.book) return;
      page.busy = true; this.translateButton.disabled = this.bookButton.disabled = true;
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
      finally { page.busy = false; if (this.alive(token)) this.translateButton.disabled = this.bookButton.disabled = false; }
    }

    async translateBook() {
      if (this.book) { this.book.abort(); return; }
      const current = this.page;
      if (!current || current.busy || !this.root) return;
      const token = this.book = new AbortController();
      const signal = token.signal;
      this.bookButton.textContent = tr("停止翻译", "Stop translation");
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
          if (signal.aborted) this.status.textContent = tr(`已停止，已处理 ${visited} 页`, `Stopped after processing ${visited} pages`);
        }
      }
    }

    paint() {
      const page = this.page, canvas = this.target.canvas;
      const ctx = canvas.getContext("2d"); ctx.drawImage(this.source.canvas, 0, 0);
      this.target.stage.replaceChildren(canvas); this.extra.replaceChildren();
      const kx = canvas.width / page.width, ky = canvas.height / page.height;
      const pixels = page.units.some((u) => u.placed && u.translation) ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
      const notes = [], hdoc = this.doc;
      for (const u of page.units) {
        if (!u.translation) continue;
        const rects = u.placed ? u.masks.map((r) => project(r, page.transform)) : [];
        const colors = rects.map((r) => paperColor(pixels, r, kx, ky));
        const fragment = hdoc.importNode(this.session.overlay._translationContent(u, u.translation), true);
        if (!rects.length || colors.some((c) => !c)) {
          notes.push([u, fragment]); continue;
        }
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]; ctx.fillStyle = `rgb(${colors[i].join(",")})`;
          ctx.fillRect(Math.floor(r.left * kx), Math.floor(r.top * ky), Math.ceil((r.left + r.width) * kx) - Math.floor(r.left * kx), Math.ceil((r.top + r.height) * ky) - Math.floor(r.top * ky));
        }
        const r = project(u.rect, page.transform);
        const block = h(hdoc, "div", "dr-parallel-text");
        // Rotate the translated line with the source's writing direction, including
        // PDF /Rotate and the reader's own rotation. The source canvas uses this viewport too.
        const [a, b, c, d] = page.transform, direction = u.direction || [1, 0];
        const angle = (Math.round(Math.atan2(b * direction[0] + d * direction[1], a * direction[0] + c * direction[1]) * 2 / Math.PI) + 4) % 4;
        block.style.transformOrigin = "0 0";
        block.style.transform = `rotate(${angle * 90}deg)`;
        block.style.left = `${r.left + (angle === 1 || angle === 2 ? r.width : 0)}px`;
        block.style.top = `${r.top + (angle === 2 || angle === 3 ? r.height : 0)}px`;
        block.style.width = `${angle % 2 ? r.height : r.width}px`;
        block.style.height = `${angle % 2 ? r.width : r.height}px`;
        if (colors[0][0] * 0.21 + colors[0][1] * 0.72 + colors[0][2] * 0.07 < 115) block.style.color = "white";
        if (u.title) block.classList.add("dr-parallel-title");
        this.target.stage.append(block);
        DeepRead.ParallelTypeset.draw(block, u, fragment, u.size * Math.hypot(page.transform[0], page.transform[1]));
      }
      if (notes.length) {
        const detail = h(hdoc, "details", "dr-parallel-unplaced"); detail.open = true;
        detail.append(h(hdoc, "summary", "", tr(`单独显示的译文（${notes.length}）`, `Translations outside the page (${notes.length})`)));
        for (const [u, frag] of notes) {
          const row = h(hdoc, "div", "dr-parallel-passage"); row.append(h(hdoc, "div", "", u.source), frag); detail.append(row);
        }
        this.extra.append(detail);
      }
      const total = page.units.length, translated = page.units.filter((u) => u.translation).length;
      const parse = this.needsParse() && (!translated || translated < total);
      this.translateButton.hidden = translated === total && !parse;
      this.translateButton.disabled = !!this.book; this.bookButton.disabled = false;
      this.translateButton.textContent = parse ? tr("解析文档并翻译本页", "Parse PDF and translate page") : tr("翻译本页", "Translate page");
      this.status.textContent = parse ? tr("将使用已配置的解析服务处理整份 PDF，再翻译本页。", "Your configured parser will process the PDF before this page is translated.")
        : total ? tr(`第 ${page.index + 1} 页 · ${translated}/${total} 处已翻译`, `Page ${page.index + 1} · ${translated}/${total} units translated`)
        : tr("本页保留原图。扫描正文需要可用的 OCR 解析结果。", "Original page shown. Scanned text needs OCR results.");
    }
  };
})();

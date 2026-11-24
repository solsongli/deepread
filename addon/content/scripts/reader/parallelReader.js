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
      this.retryParse = button(bar,"dr-parallel-reparse",tr("重试解析服务","Retry parser"),() => this.translatePage(true));
      this.retryParse.hidden = true;
      this.bookButton = button(bar, "dr-parallel-book", tr("翻译全文", "Translate all pages"), () => {
        if (this.exportJob) this.exportJob.abort(); else this.translateBook();
      });
      this.bookButton.disabled = true;
      this.bookButton.title=tr("英译中时按论文统一术语，补译缺失或用词不一致的段落","For Chinese, choose paper-specific terms and translate missing or inconsistent passages");
      this.exportControl = h(doc, "select", "dr-parallel-export");
      this.exportControl.setAttribute("aria-label", tr("保存译文或双语 PDF", "Save translated or bilingual PDF"));
      for (const [value, label] of [
        ["", tr("保存 PDF…", "Save PDF…")],
        ["page", tr("本页译文", "Current translated page")],
        ["all", tr("全文译文", "Translated document")],
        ["dual-page", tr("本页双语对照", "Bilingual page")],
        ["dual-all", tr("全文双语对照", "Bilingual document")]
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
      DeepRead.ParallelDetail.release(this.page);
      this.controller?.abort(); this.renderTask?.cancel(); this.renderTask = null;
      this.book?.abort(); this.book = null; this.termCache=null;
      this.exportJob?.abort(); this.exportJob=null;
      this.observer?.disconnect(); this.root.close(); this.root.remove(); this.root = null;
      this.doc.getElementById("deepread-parallel-css")?.remove();
      for (const sheet of [this.source, this.target]) if (sheet) sheet.canvas.width = sheet.canvas.height = 0;
      this.sheets.replaceChildren(); this.extra.replaceChildren();
      this.page = null; this.source = null; this.target = null;
      this.retryParse.hidden = true;
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
      this.page.screenDensity=scale*(this.doc.defaultView.devicePixelRatio || 1);
      DeepRead.ParallelDetail.refresh(this,this.page);
      this.minus.disabled = this.zoom <= 0.5; this.plus.disabled = this.zoom >= 3;
    }

    alive(token) { return this.root && this.controller === token && !token.signal.aborted; }

    async showPage(index, exportJob = null) {
      if (!this.root || this.book || (this.exportJob && this.exportJob!==exportJob) || !Number.isInteger(index) || index < 0 || index >= this.count) return;
      DeepRead.ParallelDetail.release(this.page);
      this.controller?.abort(); this.renderTask?.cancel(); this.renderTask = null;
      const token = this.controller = new AbortController();
      this.pageIndex = index; this.number.value = String(index + 1);
      this.previous.disabled = index === 0; this.next.disabled = index + 1 === this.count;
      this.page = null; this.source = null; this.target = null;
      this.retryParse.hidden = true;
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
        const renderInto=(canvas,scale)=>{
          const params=raw(Components.utils.createObjectIn(win));
          params.canvasContext=raw(canvas.getContext("2d"));params.viewport=viewportAt(scale);
          return raw(pdfPage.render(params));
        };
        const task = this.renderTask = renderInto(bitmap,rasterScale);
        const annotationsTask = pdfPage.getAnnotations ? Promise.resolve(pdfPage.getAnnotations(
          Components.utils.cloneInto({ intent:'display' },win))).catch(() => []) : [];
        const [pageData, annotations] = await Promise.all([this.session.pdfAdapter().pdfDocument.getPageData({ pageIndex: index }),
          annotationsTask, task.promise]);
        if (!this.alive(token)) return;
        this.renderTask = null;
        const page = this.page = { index, width, height, renderInto, transform: Array.from(viewport.transform), view: Array.from(pdfPage.view),
          chars: pageData.chars || [], fingerprint: Array.from(doc.fingerprints || []).join("/"), language: DeepRead.prefs.language() };
        const pageAnnotations=JSON.parse(win.JSON.stringify(annotations));
        page.hasAnnotationArtwork=pageAnnotations.some(a=>a.subtype!=="Link" && a.subtype!=="Popup");
        page.links=pageAnnotations.filter(a=>a.subtype==='Link' && a.rect && (a.dest || /^(?:https?:\/\/|mailto:)/i.test(a.url || '')));
        this.source = makeSheet(this.doc, tr("原文", "Original")); this.target = makeSheet(this.doc, tr("译文", "Translation"));
        for (const sheet of [this.source, this.target]) {
          sheet.stage.style.width = `${width}px`; sheet.stage.style.height = `${height}px`;
          sheet.canvas.width = bitmap.width; sheet.canvas.height = bitmap.height;
          sheet.canvas.getContext("2d").drawImage(bitmap, 0, 0);
        }
        bitmap.width = bitmap.height = 0;
        this.sheets.replaceChildren(this.source.column, this.target.column); this.resize();
        const provider = DeepRead.prefs.parserConfig().provider;
        const existing=this.session.data;
        if (existing?.resultDir && existing.contentList?.length) {
          if (this.enriched?.source!==existing.contentList) {
            this.enriched={source:existing.contentList,promise:DeepRead.Parser.enrichLayout(existing.resultDir,existing.contentList)};
          }
          await this.enriched.promise;
          if (!this.alive(token)) return;
        }
        if (this.parsed?.fingerprint !== page.fingerprint) this.parsed = null;
        if (provider !== "builtin" && !this.session.data?.contentList && this.parsed?.provider !== provider) {
          const stored = await DeepRead.Store.comparisonData(this.session.key, page.fingerprint, `parse:${provider}`);
          if (!this.alive(token)) return;
          if (stored) this.parsed = { provider, items: Array.isArray(stored) ? stored : stored.items,
            legacy:Array.isArray(stored), fallback:!!stored.fallback, fingerprint: page.fingerprint };
        }
        [page.saved] = await Promise.all([
          DeepRead.Store.comparisonData(this.session.key, page.fingerprint, slotFor(index, page.language)),
          DeepRead.PaperType.ready(this.doc, page.language),
          DeepRead.FigureOCR.discover(this,page)
        ]);
        if (!this.alive(token)) return;
        this.prepareUnits(page); this.paint();
      }
      catch (error) { if (this.alive(token)) this.status.textContent = tr("此页无法显示：", "Could not display page: ") + DeepRead.util.formatError(error); }
    }

    async openReference(index) {
      const old = this.page,
        link = old?.links?.[index];
      if (!link || this.book || this.exportJob) return;
      if (/^(?:https?:\/\/|mailto:)/i.test(link.url || "")) {
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
      if (source?.length) items = DeepRead.ParallelVisual.pageItems(source,page.index);
      else if (!paragraphs.length) items = DeepRead.TextLayerParser.buildContentList([{ pageIndex: page.index, viewBox: page.view, chars: page.chars }]);
      page.units = PLAN.plan({ paragraphs, items, nativeParser:!source?.length || !!this.parsed?.fallback || DeepRead.prefs.parserConfig().provider==="builtin", chars: page.chars, view: page.view, language: page.language, rasterLabels:page.rasterLabels,
        reuse: (!s.data?.language || s.data.language === page.language), continuationFor: (p) => s.continuationFor(p) });
      page.context = PLAN.interruptedContext(source?.length ? source : items, page.index);
      page.localItems = source?.length ? null : items;
      PLAN.setContext(page.units,page.context);
      PLAN.hydrate(page.units, page.saved);
    }

    async parseDocument(page, signal, force = false) {
      if (!force && !this.needsParse() && !this.parsed?.legacy) return;
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
      const items = parsed.contentList.map(({ id, page_idx, type, sub_type, text_level, bbox, text, list_items,
        image_caption, table_caption, chart_caption, code_caption, code_body, table_body, captionFrames, physicalParts }) =>
        ({ id, page_idx, type, sub_type, text_level, bbox, text, list_items, image_caption, table_caption, chart_caption,
          code_caption, code_body, table_body, captionFrames, physicalParts }));
      this.parsed = { provider, items, fallback:!!parsed.fallback, fingerprint: page.fingerprint };
      await DeepRead.Store.saveComparisonData(session.key, page.fingerprint, `parse:${provider}`, {version:3,items,fallback:!!parsed.fallback});
      session.hasComparisonCache = !!page.fingerprint;
    }

    async checkpoint(page, changed, signal) {
      if (signal.aborted) return;
      page.saved = await DeepRead.Store.mergeComparisonTranslations(this.session.key, page.fingerprint,
        slotFor(page.index, page.language), PLAN.records(changed));
      if (signal.aborted) return;
      this.session.hasComparisonCache = !!page.fingerprint;
      if (this.page === page && this.root) this.paint();
    }

    async prepareTranslation(page, signal, force = false) {
      if (!force && !this.needsParse() && !this.parsed?.legacy) return;
      if (!DeepRead.LLM.isConfigured()) throw new Error(DeepRead.t("error.noLLM"));
      // Only send already verified, visible native prose while the external
      // parser runs. Its finished layout can reuse the same validated records.
      const visible = page.units.filter(u=>u.placed && u.matched && !u.translation && !u.caption)
        .sort((a,b)=>b.rect[3]-a.rect[3]).slice(0,2);
      const [parsed, preview] = await Promise.allSettled([
        this.parseDocument(page,signal,force),
        PLAN.translate(visible,{language:page.language,signal,context:page.context,request:args=>DeepRead.LLM.complete(args),
          onProgress:changed=>this.checkpoint(page,changed,signal)})
      ]);
      if (signal.aborted) return;
      if (parsed.status==="rejected") throw parsed.reason;
      if (preview.status==="rejected" && !preview.reason?.incomplete) throw preview.reason;
      this.prepareUnits(page);
      if (this.page===page && this.root) this.paint();
    }

    async paperTerms(page, signal, build = false) {
      const terms = DeepRead.ParallelTerms,
        session = this.session;
      if (!terms.supported(page.language) || !page.fingerprint || this.count < 2) return [];
      const key = JSON.stringify([session.key, page.fingerprint, page.language]);
      if (this.termCache?.key === key) return this.termCache.glossary;
      let entries = await DeepRead.Store.comparisonData(
        session.key,
        page.fingerprint,
        "terms:v1:" + page.language
      );
      if (signal.aborted) return [];
      if (!Array.isArray(entries)) {
        if (!build || !DeepRead.LLM.isConfigured()) return [];
        this.status.textContent = tr("正在读取本文的重复术语…", "Finding recurring terms in this paper…");
        const parsed = session.data?.contentList?.length ? session.data.contentList : this.parsed?.items;
        const items = parsed?.length ? parsed : [],
          labels = [];
        const pdf = session.pdfAdapter().pdfDocument;
        for (let index = 0; index < this.count; index++) {
          if (signal.aborted) return [];
          let data;
          try {
            data = await pdf.getPageData({ pageIndex: index });
          } catch (error) {
            if (signal.aborted) return [];
            DeepRead.log("Could not inspect labels on page "+(index+1),String(error));
            continue;
          }
          const chars = data.chars || [];
          labels.push(...terms.shortLabels(chars));
          if (!parsed?.length)
            items.push(
              ...DeepRead.TextLayerParser.buildContentList([{ pageIndex: index, viewBox: data.viewBox, chars }])
            );
        }
        if (signal.aborted) return [];
        const candidates = terms.candidates(items, labels);
        if (candidates.length)
          this.status.textContent = tr(
            "正在统一本文反复出现的术语…",
            "Choosing consistent terms for this paper…"
          );
        const request = (args) => DeepRead.LLM.complete(args);
        const early =
          candidates.length && DeepRead.prefs.llmConfig().concurrency > 1
            ? terms.preview(page.units, candidates)
            : [];
        const [extracted, preview] = await Promise.allSettled([
          terms.extract(candidates, page.language, request, signal),
          PLAN.translate(early, {
            request,
            language: page.language,
            signal,
            context: page.context,
            onProgress: (changed) => this.checkpoint(page, changed, signal)
          })
        ]);
        if (signal.aborted) return [];
        if (preview.status === "rejected" && !preview.reason?.incomplete) throw preview.reason;
        if (extracted.status === "rejected") {
          this.termWarning = true;
          DeepRead.log("Paper terminology unavailable", String(extracted.reason));
          return [];
        }
        entries = extracted.value;
        entries = await DeepRead.Store.savePaperTerms(session.key, page.fingerprint, page.language, entries);
        if (signal.aborted) return [];
        session.hasComparisonCache = true;
      }
      const glossary = terms.compile(entries);
      if (!signal.aborted) this.termCache = { key, glossary };
      return glossary;
    }

    async translateUnits(
      page,
      signal,
      concurrency = Math.min(6, DeepRead.prefs.llmConfig().concurrency),
      glossary
    ) {
      const hadLabels = page.rasterLabels;
      try {
        await DeepRead.FigureOCR.recognize(this, page, signal);
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") throw error;
        page.figureError = true;
        DeepRead.log("Figure text unavailable; retaining original artwork", String(error));
      }
      if (signal.aborted) return;
      if (page.rasterLabels !== hadLabels && (page.rasterLabels?.length || hadLabels?.length))
        this.prepareUnits(page);
      if (!page.units.some((u) => !u.translation) && !glossary?.length) return;
      if (page.localItems?.length && this.count > 1) {
        const pdf = this.session.pdfAdapter().pdfDocument;
        const neighbours = [page.index - 1, page.index + 1].filter((index) => index >= 0 && index < this.count);
        const edges = await Promise.all(
          neighbours.map(async (index) => {
            const info = await pdf.getPageData({ pageIndex: index });
            return DeepRead.TextLayerParser.buildContentList([
              { pageIndex: index, viewBox: info.viewBox, chars: info.chars }
            ]);
          })
        );
        if (signal.aborted) return;
        const ordered = [...page.localItems, ...edges.flat()].sort((a, b) => a.page_idx - b.page_idx);
        page.context = PLAN.interruptedContext(ordered, page.index);
        PLAN.setContext(page.units, page.context);
        PLAN.hydrate(page.units, page.saved);
      }
      glossary ??= await this.paperTerms(page, signal);
      if (signal.aborted) return;
      const originals = new Map(),
        local = [];
      const work = page.units.map((unit) => {
        const bound = DeepRead.ParallelTerms.constrain(unit, glossary);
        if (!bound) return unit;
        if (bound.ready) {
          unit.termBase ||= unit.translation;
          unit.translation = bound.ready;
          local.push(unit);
          return unit;
        }
        originals.set(bound.work, { unit, restore: bound.restore });
        return bound.work;
      });
      if (local.length) await this.checkpoint(page, local, signal);
      if (signal.aborted || !work.some((u) => !u.translation)) return;
      if (!DeepRead.LLM.isConfigured()) {
        if (page.units.every((u) => u.translation)) {
          this.termWarning = true;
          return;
        }
        throw new Error(DeepRead.t("error.noLLM"));
      }
      await PLAN.translate(work, {
        language: page.language,
        signal,
        context: page.context,
        concurrency,
        request: (args) => DeepRead.LLM.complete(args),
        onProgress: (changed) => {
          const accepted = changed.map((u) => {
            const entry = originals.get(u);
            if (!entry) return u;
            entry.unit.termBase ||= entry.unit.translation;
            entry.unit.translation = entry.restore(u.translation);
            return entry.unit;
          });
          return this.checkpoint(page, accepted, signal);
        }
      });
    }

    async translatePage(forceParse = false) {
      const page = this.page, token = this.controller;
      if (!page || !this.alive(token) || page.busy || this.book || this.exportJob) return;
      page.busy = true; this.translateButton.disabled = this.bookButton.disabled = this.exportControl.disabled = true;
      try {
        await this.prepareTranslation(page,token.signal,forceParse);
        if (!this.alive(token)) return;
        this.status.textContent = tr("正在翻译本页…", "Translating this page…");
        await this.translateUnits(page, token.signal);
        if (this.alive(token)) this.paint();
      }
      catch (error) { if (this.alive(token)) this.status.textContent = tr("本页翻译失败：", "Page translation failed: ") + DeepRead.util.formatError(error); }
      finally {
        page.busy = false;
        if (this.alive(token)) {
          this.translateButton.disabled = this.bookButton.disabled = this.retryParse.disabled = false;
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
      let visited = 0, originals = 0, stoppedBy;
      const failures = [];
      try {
        await this.prepareTranslation(current,signal);
        if (signal.aborted) return;
        this.termWarning=false;
        const glossary=await this.paperTerms(current,signal,true);
        if (signal.aborted) return;
        const adapter = this.session.pdfAdapter();
        const order = [current.index, ...Array.from({length:this.count}, (_, i) => i).filter(i => i !== current.index)];
        const limit = Math.min(6, DeepRead.prefs.llmConfig().concurrency);
        const workers = Math.min(3, limit, order.length);
        let next = 0;
        const run = async () => {
          while (next < order.length && !signal.aborted && !stoppedBy) {
            const index = order[next++];
            try {
              this.status.textContent = tr(`全文翻译 · 已处理 ${visited}/${this.count} 页 · 正在处理第 ${index + 1} 页`,
                `Translating page ${index + 1} · ${visited} of ${this.count} processed`);
              let page = current;
              if (index !== current.index) {
                const [geometry, data, saved] = await Promise.all([adapter.pdfDocument.getPage(index + 1),
                  adapter.pdfDocument.getPageData({ pageIndex: index }), DeepRead.Store.comparisonData(this.session.key, current.fingerprint, slotFor(index, current.language))]);
                if (signal.aborted) return;
                page = { index, language: current.language, fingerprint: current.fingerprint, view: geometry.view, chars: data.chars || [], saved };
                this.prepareUnits(page);
              }
              await this.translateUnits(page, signal, Math.floor(limit / workers),glossary);
              if (signal.aborted) return;
              if (!page.units.length) originals++;
              visited++;
            } catch (error) {
              if (signal.aborted) return;
              if (error.incomplete) failures.push(index + 1);
              else stoppedBy ||= { page:index + 1, error };
            }
          }
        };
        await Promise.all(Array.from({length:workers}, run));
        if (signal.aborted) return;
        if (stoppedBy) throw stoppedBy.error;
        const incomplete = failures.sort((a,b) => a-b).join(", ");
        this.status.textContent = tr(`已处理 ${visited} 页`, `Processed ${visited} pages`) +
          (originals ? tr(`，其中 ${originals} 页保留原图`, ` · ${originals} original-only pages`) : "") +
          (incomplete ? tr(` · 以下页仍有待译段落，再点翻译全文可续译：${incomplete}`,
            ` · Pending passages on pages ${incomplete}. Choose Translate all pages to resume.`) : "");
        if (this.termWarning) this.status.textContent+=tr(" · 本次术语提取未完成"," · Paper terminology unavailable");
      }
      catch (error) {
        if (!signal.aborted && this.root) this.status.textContent = tr(`第 ${stoppedBy?.page ?? current.index + 1} 页未完成：`,
          `Page ${stoppedBy?.page ?? current.index + 1} failed: `) + DeepRead.util.formatError(error);
      }
      finally {
        if (this.book === token) {
          this.book = null; this.bookButton.textContent = tr("翻译全文", "Translate all pages");
          this.translateButton.disabled = this.number.disabled = this.retryParse.disabled = false;
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
      const bilingual = scope === "dual-page" || scope === "dual-all";
      const whole = scope === "all" || scope === "dual-all";
      let tmpPath,
        message = "";
      try {
        if (!path) {
          const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
          const picker = new FilePicker();
          picker.init(
            this.session.reader._window || Zotero.getMainWindow(),
            bilingual ? tr("保存双语对照 PDF","Save bilingual PDF") : tr("保存译文 PDF", "Save translated PDF"),
            picker.modeSave
          );
          const name = (this.session.item.attachmentFilename || "paper").replace(/\.pdf$/i, "");
          picker.defaultString = `${name}-${current.language}${bilingual ? "-dual" : ""}${whole ? "" : `-p${start + 1}`}.pdf`;
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
        pdf.setTitle((this.session.item.attachmentFilename || "DeepRead") + ` · ${current.language}` +
          (bilingual ? tr(" · 双语对照"," · Bilingual") : ""));
        const facing = bilingual ? await DeepRead.ParallelPDF.facingDocument(pdf,this,source) : null;
        const first = whole ? 0 : start, last = whole ? this.count - 1 : start;
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
          await DeepRead.ParallelPDF.append(pdf, this, signal, facing);
        }
        if (signal.aborted) return false;
        if (facing) await facing.finish(signal);
        if (signal.aborted) return false;
        const bytes = await pdf.save();
        if (signal.aborted) return false;
        tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
        await IOUtils.write(path, Uint8Array.from(bytes), { tmpPath });
        message = bilingual ? tr("已保存双语对照 PDF","Bilingual PDF saved") : tr("已保存译文 PDF", "Translated PDF saved");
        return true;
      } finally {
        if (tmpPath) await IOUtils.remove(tmpPath, { ignoreAbsent: true });
        if (this.exportJob === token) {
          if (this.pageIndex !== start) await this.showPage(start, token);
          if (this.exportJob === token) {
            this.exportJob = null;
            DeepRead.ParallelDetail.refresh(this,this.page);
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
      page.dirtyRects=[];
      for (const u of page.units) {
        if (!u.translation) continue;
        const rects = u.placed ? u.masks.map((r) => project(r, page.transform)) : [];
        const patches=u.verifiedLabel && u.placed ? u.masks.map(mask=>DeepRead.ParallelInk.labelPatch(pixels,mask,page,u.size)) : [];
        const colors = rects.map((r,i) => u.verifiedLabel ? patches[i]?.color : paperColor(pixels, r, kx, ky));
        const originalFragment = hdoc.importNode(this.session.overlay._translationContent(u, u.translation, page.language), true);
        let fragment = materialize(hdoc,originalFragment,u,page,this.source.canvas,pixels);
        if(!u.title && !u.caption && /^zh(?:-|$)/i.test(page.language)) DeepRead.PaperType.separateLead(fragment,u.modelText);
        const samples=u.linkSamples || [];
        if (samples.length && !fragment.querySelector("a")) {
          const ids=samples.map(rect=>DeepRead.ParallelInk.sourceLink({samples:[rect]},page));
          const id=ids.find(i=>i>=0);
          if (id!=null && ids.filter(i=>i===id).length>=samples.length*.9) {
            const link=h(hdoc,"a");link.href="#";link.dataset.sourceLink=String(id);
            link.style.color=DeepRead.ParallelInk.inkColor({samples},page,pixels);
            link.append(fragment);fragment=hdoc.createDocumentFragment();fragment.append(link);
          }
        }
        if (!rects.length || colors.some((c) => !c)) {
          notes.push([u, fragment]); page.supplements.push(u); continue;
        }
        page.dirtyRects.push(...rects);
        for (let i = 0; i < rects.length; i++) {
          if(patches[i]) { patches[i].erase(ctx);continue; }
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
        DeepRead.PaperType.apply(block, page.language);
        // Rotate the translated line with the source's writing direction, including
        // PDF /Rotate and the reader's own rotation. The source canvas uses this viewport too.
        const angle = orientation(u,page);
        let layoutUnit=u;
        if(angle===0 && u.titleInsets) {
          const k=Math.hypot(page.transform[0],page.transform[1]);
          r.top-=u.titleInsets[0]*k;r.height+=(u.titleInsets[0]+u.titleInsets[1])*k;
        }
        if(angle===0 && ["table_label","figure_label","algorithm_step"].includes(u.role) && patches.length===1 && patches[0]) {
          const mask=rects[0];
          const left=patches[0].left+Math.max(0,r.left-mask.left);
          const right=patches[0].right+Math.max(0,mask.left+mask.width-r.left-r.width);
          if(!u.flushLeft && u.role!=="algorithm_step" && Math.min(left,right)>1 && Math.abs(left-right)<u.size*.8) {
            r.left-=left;r.width+=left+right;layoutUnit={...u,centered:true};
          } else r.width+=right;
        }
        block.style.transformOrigin = "0 0";
        block.style.transform = `rotate(${angle * 90}deg)`;
        block.style.left = `${r.left + (angle === 1 || angle === 2 ? r.width : 0)}px`;
        block.style.top = `${r.top + (angle === 2 || angle === 3 ? r.height : 0)}px`;
        block.style.width = `${angle % 2 ? r.height : r.width}px`;
        block.style.height = `${(angle % 2 ? r.width : r.height) + (angle===0 && !u.title ? u.clearance || 0 : 0)}px`;
        if (colors[0][0] * 0.21 + colors[0][1] * 0.72 + colors[0][2] * 0.07 < 115) block.style.color = "white";
        else if (u.styleSamples) block.style.color=DeepRead.ParallelInk.inkColor({samples:u.styleSamples},page,pixels);
        if (u.title && u.boldTitle) block.classList.add("dr-parallel-title");
        const chinese = /^zh(?:-|$)/i.test(page.language);
        if ((u.sans && (u.title || !chinese)) || u.role==="figure_label") block.classList.add("dr-paper-sans");
        if (chinese && u.title && u.allItalic) block.classList.add("dr-paper-subheading");
        if (u.allItalic) block.style.fontStyle='italic';
        this.target.stage.append(block);
        DeepRead.ParallelTypeset.draw(block, layoutUnit, fragment, u.size * Math.hypot(page.transform[0], page.transform[1]));
        if (block.dataset.overflow) page.supplements.push(u);
        this.pair(u,block,false);
      }
      if (notes.length) {
        const detail = h(hdoc, "details", "dr-parallel-unplaced"); detail.open = true;
        detail.append(h(hdoc, "summary", "", tr(`单独显示的译文（${notes.length}）`, `Translations outside the page (${notes.length})`)));
        for (const [u, frag] of notes) {
          const row = h(hdoc, "div", "dr-parallel-passage");
          const translated = h(hdoc, "div");
          DeepRead.PaperType.apply(translated, page.language);
          translated.append(frag);
          row.append(h(hdoc, "div", "", u.source), translated); detail.append(row);
          this.pair(u,row,true);
        }
        this.extra.append(detail);
      }
      DeepRead.ParallelDetail.refresh(this,page);
      const total = page.units.length, translated = page.units.filter((u) => u.translation).length;
      this.refreshExport();
      this.retryParse.hidden = !this.parsed?.fallback || !!this.session.data?.contentList?.length;
      this.retryParse.disabled = !!this.book || !!this.exportJob || !!page.busy;
      const parse = this.needsParse() && (!translated || translated < total);
      this.translateButton.hidden = translated === total && !parse && !this.parsed?.legacy && !page.imageCandidates?.length;
      this.translateButton.disabled = !!this.book || !!this.exportJob || !!page.busy; this.bookButton.disabled = !!page.busy;
      this.translateButton.textContent = this.parsed?.legacy ? tr("补全版面并翻译本页","Refresh layout and translate page")
        : parse ? tr("解析文档并翻译本页", "Parse PDF and translate page") : tr("翻译本页", "Translate page");
      this.status.textContent = parse ? tr("将使用已配置的解析服务处理整份 PDF，再翻译本页。", "Your configured parser will process the PDF before this page is translated.")
        : total ? tr(`第 ${page.index + 1} 页 · 原位 ${translated-notes.length}/${total} 处`, `Page ${page.index + 1} · ${translated-notes.length}/${total} in place`)
          + (notes.length ? tr(` · 页下 ${notes.length} 处`, ` · ${notes.length} below`) : '')
          + (page.supplements.length>notes.length ? tr(` · 段内滚动 ${page.supplements.length-notes.length} 处`, ` · ${page.supplements.length-notes.length} scrollable`) : '')
          + (total>translated ? tr(` · 待译 ${total-translated} 处`, ` · ${total-translated} pending`) : '')
        : tr("本页保留原图。扫描正文需要可用的 OCR 解析结果。", "Original page shown. Scanned text needs OCR results.");
      if (this.parsed?.fallback) this.status.textContent+=tr(" · 本次使用 PDF 文字层"," · Using PDF text layer");
      if (page.figureError) this.status.textContent+=tr(" · 图内文字识别未完成，保留原图"," · Figure text unavailable, original artwork shown");
      else if (page.imageCandidates?.length) this.status.textContent+=tr(" · 图内文字待识别"," · Figure labels pending");
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

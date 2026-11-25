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

  DeepRead.ParallelReader = class ParallelReader {
    constructor(session) {
      this.session = session;
    }

    async open(trigger) {
      if (this.root) {
        this.close();
        return;
      }
      await this.session.init();
      if (this.root || !this.session.overlay.attached || this.session.status === "running") return;
      const { readerDoc: doc, app } = this.session.overlay;
      this.doc = doc;
      this.trigger = trigger;
      this.count = app.pdfDocument.numPages;
      const sheet=DeepRead.util.readyStylesheet(
        doc,
        "chrome://deepread/content/styles/parallel.css",
        "deepread-parallel-css"
      );
      const host = doc.getElementById("split-view");
      const root = (this.root = h(doc, "section", "deepread-parallel dr-native-tools"));
      root.id = "deepread-native-controls";
      // Keep the command bar out of Zotero's flex split on its first layout.
      Object.assign(root.style,{position:"absolute",inset:"0 0 auto"});
      root.setAttribute("aria-label", tr("原版对照", "Parallel reading"));
      const bar = h(doc, "div", "dr-parallel-bar");
      const button = (parent, cls, label, action) => {
        const b = h(doc, "button", cls, label);
        b.type = "button";
        b.addEventListener("click", action);
        parent.append(b);
        return b;
      };
      this.status = h(doc, "span", "dr-parallel-status");
      this.status.setAttribute("role", "status");
      bar.append(this.status);
      this.translateButton = button(bar, "dr-parallel-translate", tr("翻译本页", "Translate page"), () =>
        this.translatePage()
      );
      this.retryParse = button(bar, "dr-parallel-reparse", tr("重试解析服务", "Retry parser"), () =>
        this.translatePage(true)
      );
      this.retryParse.hidden = true;
      this.bookButton = button(bar, "dr-parallel-book", tr("翻译全文", "Translate all pages"), () => {
        if (this.exportJob) this.exportJob.abort();
        else this.translateBook();
      });
      this.bookButton.disabled = true;
      this.bookButton.title = tr(
        "英译中时按论文统一术语，补译缺失或用词不一致的段落",
        "For Chinese, choose paper-specific terms and translate missing or inconsistent passages"
      );
      this.exportControl = h(doc, "select", "dr-parallel-export");
      this.exportControl.setAttribute(
        "aria-label",
        tr("保存译文或双语 PDF", "Save translated or bilingual PDF")
      );
      for (const [value, label] of [
        ["", tr("页码与导出…", "Pages and export…")],
        ["options", tr("选页、版式与入库…", "Page range, layout and library…")],
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
        if (scope === "options") DeepRead.TranslationOptions.open(this);
        else if (scope)
          this.savePDF(scope).catch((err) => {
            if (this.root) this.status.textContent = DeepRead.util.formatError(err);
          });
      });
      bar.append(this.exportControl);
      this.back = button(bar, "dr-parallel-close", tr("退出对照", "Close comparison"), () => this.close());
      root.append(bar);
      host.append(root);
      host.classList.add("dr-native-active");
      this.barObserver = new doc.defaultView.ResizeObserver(() =>
        host.style.setProperty("--dr-native-bar", root.offsetHeight + "px")
      );
      this.barObserver.observe(root);
      host.style.setProperty("--dr-native-bar", root.offsetHeight + "px");
      this.status.textContent = tr("正在打开原生对照…", "Opening parallel views…");
      this.session._emit("comparison");
      const native = (this.native = new DeepRead.NativeParallelView(this));
      try {
        await sheet;
        if(this.native!==native)return;
        await native.open();
        if (this.root && this.native === native)
          await this.showPage(native.active ?? app.pdfViewer.currentPageNumber - 1, null, true);
      } catch (error) {
        if (this.native === native) this.close();
        throw error;
      }
    }

    close(navigate = true, restore = true) {
      if (!this.root) return;
      this.optionsDialog?.close();
      this.passageDialog?.close();
      this.book?.abort();
      this.book = null;
      this.exportJob?.abort();
      this.exportJob = null;
      this.native?.close(restore);
      this.native = null;
      this.releaseSurface(this.exportSurface);
      this.exportSurface = null;
      this.barObserver?.disconnect();
      const host = this.root.parentNode;
      host?.classList.remove("dr-native-active");
      host?.style.removeProperty("--dr-native-bar");
      this.root.remove();
      this.root = null;
      this.surface = null;
      this.page = null;
      this.source = null;
      this.target = null;
      this.scopedParse = null;
      this.termCache = null;
      this.controller = null;
      this.following = null;
      this.doc.getElementById("deepread-parallel-css")?.remove();
      if (navigate) this.trigger?.focus({ preventScroll: true });
      this.trigger = null;
      this.session._emit("comparison");
    }

    alive(token) {
      return this.root && this.controller === token && !token?.signal.aborted;
    }

    makeSurface(doc, index, rotation) {
      const host = h(doc, "div", "dr-native-page"),
        stage = h(doc, "div", "dr-parallel-stage");
      // PDF.js installs its embedded fonts in the source iframe.
      const source = { canvas: h(this.session.overlay.pdfDoc, "canvas") };
      const target = { stage, canvas: h(doc, "canvas") };
      host.append(stage);
      const extra = h(doc, "div", "dr-parallel-extra");
      return {
        index,
        rotation,
        doc,
        host,
        source,
        target,
        extra,
        controller: new AbortController(),
        session: this.session
      };
    }

    releaseSurface(surface) {
      if (!surface) return;
      surface.controller.abort();
      if (!Components.utils.isDeadWrapper(surface.doc)) {
        DeepRead.ParallelDetail.release(surface.page);
        surface.host.remove();
        surface.extra.replaceChildren();
        surface.source.canvas.width =
          surface.source.canvas.height =
          surface.target.canvas.width =
          surface.target.canvas.height =
            0;
      }
      surface.page = null;
    }

    followPage(index) {
      if (this.following === index || this.book || this.exportJob || this.page?.busy) return;
      this.following = index;
      this.showPage(index, null, true)
        .catch((error) => {
          if (this.root && this.native?.active === index)
            this.status.textContent = DeepRead.util.formatError(error);
        })
        .finally(() => {
          if (this.following === index) this.following = null;
        });
    }

    async showPage(index, exportJob = null, fromViewer = false) {
      if (
        !this.root ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= this.count ||
        (this.exportJob && this.exportJob !== exportJob)
      )
        return;
      let s;
      if (exportJob) {
        this.releaseSurface(this.exportSurface);
        s = this.exportSurface = this.makeSurface(
          this.doc,
          index,
          this.session.overlay.app.pdfViewer.pagesRotation || 0
        );
        s.host.classList.add("dr-native-print-work");
        this.doc.body.append(s.host);
        const abort = () => s.controller.abort();
        exportJob.signal.addEventListener("abort", abort, { once: true });
        try {
          await this.compose(s);
        } finally {
          exportJob.signal.removeEventListener("abort", abort);
        }
      } else {
        const native = this.native;
        if (!native?.ready) return;
        if (!fromViewer) native.navigate(index);
        if (this.book || this.page?.busy) return;
        if (this.pageIndex !== index || !this.surface?.page) {
          this.translateButton.disabled =
            this.bookButton.disabled =
            this.retryParse.disabled =
            this.exportControl.disabled =
              true;
          this.status.textContent = tr(`正在显示第 ${index + 1} 页…`, `Loading page ${index + 1}…`);
        }
        s = await native.ensure(index);
        if (native !== this.native || native.active !== index || this.book || this.exportJob) return;
      }
      if (!s?.page?.units || s.controller.signal.aborted || !this.root) return;
      this.surface = s;
      this.controller = s.controller;
      this.pageIndex = index;
      this.page = s.page;
      this.source = s.source;
      this.target = s.target;
      this.extra = s.extra;
      if (!exportJob) this.updateStatus();
      return s;
    }

    async compose(surface) {
      const { index, controller: token, source, target } = surface;
      const overlay = this.session.overlay,
        win = overlay.pdfWin,
        doc = overlay.app.pdfDocument;
      const pdfPage = raw(await doc.getPage(index + 1));
      if (token.signal.aborted) return;
      const rotation = ((pdfPage.rotate || 0) + surface.rotation) % 360;
      const viewportAt = (scale) =>
        raw(pdfPage.getViewport(Components.utils.cloneInto({ scale, rotation }, win)));
      const viewport = viewportAt(1);
      const width = viewport.width,
        height = viewport.height;
      const rasterScale = Math.min(2, 4096 / Math.max(width, height), Math.sqrt(4500000 / (width * height)));
      const bitmap = source.canvas;
      bitmap.width = Math.max(1, Math.ceil(width * rasterScale));
      bitmap.height = Math.max(1, Math.ceil(height * rasterScale));
      const renderInto = (canvas, scale) => {
        const params = raw(Components.utils.createObjectIn(win));
        params.canvasContext = raw(canvas.getContext("2d"));
        params.viewport = viewportAt(scale);
        return raw(pdfPage.render(params));
      };
      const task = renderInto(bitmap, rasterScale);
      const cancel = () => task.cancel();
      token.signal.addEventListener("abort", cancel, { once: true });
      const annotationsTask = pdfPage.getAnnotations
        ? Promise.resolve(pdfPage.getAnnotations(Components.utils.cloneInto({ intent: "display" }, win))).catch(
            () => []
          )
        : [];
      const [pageData, annotations] = await Promise.all([
        this.session.pdfAdapter().pdfDocument.getPageData({ pageIndex: index }),
        annotationsTask,
        task.promise
      ]).finally(() => token.signal.removeEventListener("abort", cancel));
      if (token.signal.aborted) return;
      const page = (surface.page = {
        index,
        width,
        height,
        renderInto,
        transform: Array.from(viewport.transform),
        view: Array.from(pdfPage.view),
        chars: pageData.chars || [],
        fingerprint: Array.from(doc.fingerprints || []).join("/"),
        language: DeepRead.prefs.language()
      });
      const pageAnnotations = JSON.parse(win.JSON.stringify(annotations));
      page.hasAnnotationArtwork = pageAnnotations.some((a) => a.subtype !== "Link" && a.subtype !== "Popup");
      page.links = pageAnnotations.filter(
        (a) => a.subtype === "Link" && a.rect && (a.dest || /^(?:https?:\/\/|mailto:)/i.test(a.url || ""))
      );
      target.stage.style.width = width + "px";
      target.stage.style.height = height + "px";
      target.canvas.width = bitmap.width;
      target.canvas.height = bitmap.height;
      target.canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const provider = DeepRead.prefs.parserConfig().provider;
      const existing = this.session.data;
      if (existing?.resultDir && existing.contentList?.length) {
        if (this.enriched?.source !== existing.contentList) {
          this.enriched = {
            source: existing.contentList,
            promise: DeepRead.Parser.enrichLayout(existing.resultDir, existing.contentList)
          };
        }
        await this.enriched.promise;
        if (token.signal.aborted) return;
      }
      if (this.parsed?.fingerprint !== page.fingerprint) this.parsed = null;
      if (provider !== "builtin" && !this.session.data?.contentList && this.parsed?.provider !== provider) {
        const stored = await DeepRead.Store.comparisonData(
          this.session.key,
          page.fingerprint,
          `parse:${provider}`
        );
        if (token.signal.aborted) return;
        if (stored)
          this.parsed = {
            provider,
            items: Array.isArray(stored) ? stored : stored.items,
            legacy: Array.isArray(stored),
            fallback: !!stored.fallback,
            downloadJob: stored.downloadJob,
            fingerprint: page.fingerprint
          };
      }
      if (this.needsDocumentParse() || this.parsed?.legacy || this.parsed?.fallback) {
        page.partial = (await this.partialLayouts(page)).get(index);
        if (token.signal.aborted) return;
      }
      [page.saved, page.styleProfile] = await Promise.all([
        DeepRead.Store.comparisonData(this.session.key, page.fingerprint, slotFor(index, page.language)),
        DeepRead.PaperStyles.resolve(this.session),
        DeepRead.PaperType.ready(surface.doc, page.language),
        DeepRead.FigureOCR.discover(this, page)
      ]);
      if (token.signal.aborted) return;
      this.prepareUnits(page);
      this.paintSurface(surface);
    }

    async openReference(index, old=this.page) {
      const link = old?.links?.[index];
      if (!link) return;
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
      if (this.root) { this.native.navigate(number); this.native.schedule(); }
    }

    needsDocumentParse() {
      const provider = DeepRead.prefs.parserConfig().provider;
      return provider !== "builtin" && !this.session.data?.contentList?.length && !this.session.hasResults && this.parsed?.provider !== provider;
    }

    needsParse(page=this.page) {
      return this.needsDocumentParse() && !page?.partial;
    }

    partialLayouts(page) {
      const provider=DeepRead.prefs.parserConfig().provider;
      const key=JSON.stringify([page.fingerprint,provider]);
      if (this.scopedParse?.key !== key) {
        const promise = DeepRead.RangeParser.load(this.session.key,page.fingerprint,provider);
        this.scopedParse = {key,promise};
        promise.catch(()=>{if (this.scopedParse?.promise === promise) this.scopedParse = null;});
      }
      return this.scopedParse.promise;
    }

    prepareUnits(page) {
      const s = this.session;
      let source = s.data?.contentList;
      if (!source?.length && this.parsed?.provider === DeepRead.prefs.parserConfig().provider) source = this.parsed.items;
      const usePartial = page.partial && !s.data?.contentList?.length && (!source?.length || this.parsed?.legacy || this.parsed?.fallback);
      if (usePartial) source = page.partial.items;
      const paragraphs = (s.data?.hierarchicalData?.find((p) => p.pageIndex === page.index)?.paragraphs || []).map((p) => ({ ...p, pageIndex: page.index }));
      let items = [];
      if (source?.length) items = DeepRead.ParallelVisual.pageItems(source,page.index);
      else if (!paragraphs.length && !page.partial) items = DeepRead.TextLayerParser.buildContentList([{ pageIndex: page.index, viewBox: page.view, chars: page.chars }]);
      page.units = PLAN.plan({ paragraphs, items, nativeParser:!source?.length || (usePartial ? page.partial.fallback : !!this.parsed?.fallback) || DeepRead.prefs.parserConfig().provider==="builtin", chars: page.chars, view: page.view, language: page.language, rasterLabels:page.rasterLabels, saved:page.saved,
        reuse: (!s.data?.language || s.data.language === page.language), continuationFor: (p) => s.continuationFor(p) });
      page.context = PLAN.interruptedContext(source?.length ? source : items, page.index);
      page.localItems = source?.length ? null : items;
      PLAN.setContext(page.units,page.context);
      PLAN.hydrate(page.units, page.saved);
      if (page.styleProfile) {
        DeepRead.PaperStyles.classify(page.units,page.styleProfile,DeepRead.PaperStyles.documentStructure(s.data?.contentList?.length ? s.data.contentList : this.parsed?.items || source),page.view,Math.hypot(page.transform[0],page.transform[1]));
        page.equations=items.filter(it=>["equation","formula","interline_equation"].includes(it.type))
          .map(it=>PLAN.fromPermille(it.bbox,page.view)).filter(Boolean).map(rect=>project(rect,page.transform));
      }
    }

    async parseDocument(page, signal, force = false) {
      if (!force && !this.needsDocumentParse() && !this.parsed?.legacy) return;
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
        parsed = await DeepRead.RangeParser.parse(this,page,{ filePath: path, attachmentKey: scratch, pdfApp: session.pdfAdapter(), signal,
          onStatus: (progress) => { if (!signal.aborted) this.status.textContent = progress.message; } });
      }
      finally { await IOUtils.remove(scratchPath, { recursive: true, ignoreAbsent: true }); }
      if (signal.aborted) return;
      const items = parsed.contentList.map(({ id, page_idx, type, sub_type, text_level, bbox, text, list_items,
        image_caption, table_caption, chart_caption, code_caption, code_body, table_body, captionFrames, physicalParts }) =>
        ({ id, page_idx, type, sub_type, text_level, bbox, text, list_items, image_caption, table_caption, chart_caption,
          code_caption, code_body, table_body, captionFrames, physicalParts }));
      this.parsed = { provider, items, fallback:!!parsed.fallback, downloadJob:parsed.downloadJob, fingerprint: page.fingerprint };
      await DeepRead.Store.saveComparisonData(session.key, page.fingerprint, `parse:${provider}`, {version:3,items,fallback:!!parsed.fallback,downloadJob:parsed.downloadJob});
      session.hasComparisonCache = !!page.fingerprint;
    }

    async checkpoint(page, changed, signal) {
      if (signal.aborted) return;
      page.saved = await DeepRead.Store.mergeComparisonTranslations(this.session.key, page.fingerprint,
        slotFor(page.index, page.language), PLAN.records(changed));
      if (signal.aborted) return;
      this.session.hasComparisonCache = !!page.fingerprint;
      if (this.page === page && this.root) this.paint();
      else this.native?.accept(page);
    }

    async prepareTranslation(page, signal, force = false) {
      if (!force && !this.needsDocumentParse() && !this.parsed?.legacy) return;
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
      glossary,
      selection
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
        const neighbours = [page.index - 1, page.index + 1].filter((index) => index >= 0 && index < this.count && (!selection || selection.has(index)));
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
      let context=page.context;
      if (selection && !page.localItems?.length) {
        const source=this.session.data?.contentList?.length ? this.session.data.contentList : this.parsed?.items || [];
        const nearby=[page.index-1,page.index,page.index+1].filter(i=>selection.has(i)).flatMap(i=>
          source.length?DeepRead.ParallelVisual.pageItems(source,i):(selection.get(i)?.items || []));
        context=PLAN.interruptedContext(nearby,page.index);
      }
      const originals = new Map(),
        local = [];
      const work = page.units.map((unit) => {
        const bound = DeepRead.ParallelTerms.constrain(unit, glossary);
        if (!bound && !selection) return unit;
        if (bound?.ready) {
          unit.termBase ||= unit.translation;
          unit.translation = bound.ready;
          local.push(unit);
          return unit;
        }
        const item=bound?.work || {...unit};
        if(selection) Object.assign(item,{context:undefined,before:undefined,after:undefined,foreignNumbers:undefined});
        originals.set(item,{unit,restore:bound?.restore});
        return item;
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
        context,
        concurrency,
        request: (args) => DeepRead.LLM.complete(args),
        onProgress: (changed) => {
          const accepted = changed.map((u) => {
            const entry = originals.get(u);
            if (!entry) return u;
            if(entry.restore) entry.unit.termBase ||= entry.unit.translation;
            entry.unit.translation = entry.restore ? entry.restore(u.translation) : u.translation;
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
        if (forceParse || this.needsParse(page) || (this.parsed?.legacy && !page.partial)) {
          if (!DeepRead.LLM.isConfigured()) throw new Error(DeepRead.t("error.noLLM"));
          const partials = await this.partialLayouts(page);
          await DeepRead.RangeParser.fill(this,page,[page.index],partials,token.signal,forceParse);
          if (!this.alive(token)) return;
          page.partial = partials.get(page.index);
          this.prepareUnits(page);
        }
        if (!this.alive(token)) return;
        this.status.textContent = tr("正在翻译本页…", "Translating this page…");
        await this.translateUnits(page, token.signal, undefined, undefined, new Map([[page.index,page.partial]]));
        if (this.alive(token)) this.paint();
      }
      catch (error) { if (this.alive(token)) this.status.textContent = tr("本页翻译失败：", "Page translation failed: ") + DeepRead.util.formatError(error); }
      finally {
        page.busy = false;
        if(this.root)this.native?.schedule();
        if (this.alive(token)) {
          this.translateButton.disabled = this.bookButton.disabled = this.retryParse.disabled = false;
          this.refreshExport();
        }
      }
    }

    async translateBook(indices) {
      if (this.book) { this.book.abort(); return; }
      const current = this.page;
      if (!current || current.busy || !this.root || this.exportJob) return;
      const selected=indices ? DeepRead.PageRange.normalized(indices,this.count) : Array.from({length:this.count},(_,i)=>i);
      const restricted=selected.length<this.count;
      const token = this.book = new AbortController();
      const signal = token.signal;
      this.bookButton.textContent = tr("停止翻译", "Stop translation");
      this.exportControl.disabled=true;
      this.translateButton.disabled = true;
      let visited = 0, originals = 0, fallbackPages = 0, stoppedBy;
      const failures = [];
      try {
        let partials;
        const missingDocument = this.needsDocumentParse() || this.parsed?.legacy;
        if (missingDocument || this.parsed?.fallback) partials=await this.partialLayouts(current);
        if (missingDocument && (restricted || partials.size)) {
          await DeepRead.RangeParser.fill(this,current,selected,partials,signal);
          if (signal.aborted) return false;
          if(selected.includes(current.index)) {
            current.partial=partials.get(current.index);this.prepareUnits(current);this.paint();
          }
          if (!restricted) {
            const provider=DeepRead.prefs.parserConfig().provider;
            const items=selected.flatMap(i=>partials.get(i).items);
            const fallback=selected.some(i=>partials.get(i).fallback);
            this.parsed={provider,items,fallback,fingerprint:current.fingerprint};
            await DeepRead.Store.saveComparisonData(this.session.key,current.fingerprint,`parse:${provider}`,{version:3,items,fallback});
          }
        } else if (!restricted) await this.prepareTranslation(current,signal);
        if (signal.aborted) return false;
        this.termWarning=false;
        const glossary=await this.paperTerms(current,signal,!restricted);
        if (signal.aborted) return false;
        const adapter = this.session.pdfAdapter();
        const order = selected.includes(current.index) ? [current.index,...selected.filter(i=>i!==current.index)] : selected;
        const selection=restricted?new Map(selected.map(i=>[i,partials?.get(i)])):null;
        const limit = Math.min(6, DeepRead.prefs.llmConfig().concurrency);
        const workers = Math.min(3, limit, order.length);
        let next = 0;
        const run = async () => {
          while (next < order.length && !signal.aborted && !stoppedBy) {
            const index = order[next++];
            try {
              this.status.textContent = tr(`已处理 ${visited}/${selected.length} 页 · 正在翻译第 ${index+1} 页`,
                `Translating page ${index+1} · ${visited} of ${selected.length} processed`);
              let page = current;
              if (index !== current.index) {
                const [geometry, data, saved] = await Promise.all([adapter.pdfDocument.getPage(index + 1),
                  adapter.pdfDocument.getPageData({ pageIndex: index }), DeepRead.Store.comparisonData(this.session.key, current.fingerprint, slotFor(index, current.language))]);
                if (signal.aborted) return;
                page = { index, language: current.language, fingerprint: current.fingerprint, view: geometry.view, chars: data.chars || [], saved, partial:partials?.get(index) };
                this.prepareUnits(page);
              }
              await this.translateUnits(page, signal, Math.floor(limit / workers),glossary,selection);
              if (signal.aborted) return;
              this.native?.accept(page);
              if (!page.units.length) originals++;
              if (page.partial ? page.partial.fallback : this.parsed?.fallback) fallbackPages++;
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
          (fallbackPages ? tr(` · ${fallbackPages} 页使用了 PDF 文字层`, ` · ${fallbackPages} pages used the PDF text layer`) : "") +
          (incomplete ? tr(` · 以下页仍有待译段落，可再次翻译所选页：${incomplete}`,
            ` · Pending passages on pages ${incomplete}. Select those pages to resume.`) : "");
        if (this.termWarning) this.status.textContent+=tr(" · 本次术语提取未完成"," · Paper terminology unavailable");
        return !failures.length;
      }
      catch (error) {
        if (!signal.aborted && this.root) this.status.textContent = (stoppedBy
          ? tr(`第 ${stoppedBy.page} 页未完成：`, `Page ${stoppedBy.page} failed: `)
          : tr("翻译未完成：","Translation incomplete: ")) + DeepRead.util.formatError(error);
      }
      finally {
        if (this.book === token) {
          this.book = null; this.bookButton.textContent = tr("翻译全文", "Translate all pages");
          this.translateButton.disabled = this.retryParse.disabled = false;
          this.native?.schedule();
          this.refreshExport();
          if (signal.aborted) this.status.textContent = tr(`已停止，已处理 ${visited} 页`, `Stopped after processing ${visited} pages`);
        }
      }
    }

    refreshExport() {
      const units = this.page?.units;
      this.exportControl.disabled = !units || !!this.book || !!this.exportJob || !!this.page?.busy;
      const incomplete = !units || this.needsParse() || units.some(u => !u.translation);
      for (const option of this.exportControl.options) {
        if (option.value && option.value !== "options") option.disabled = incomplete;
      }
    }

    async savePDF(scope = "page", path, options = {}) {
      const current = this.page;
      if (!current?.units || current.busy || this.book || this.exportJob || !this.root) return false;
      const start = this.pageIndex;
      const whole = scope === "all" || scope === "dual-all";
      const indices = options.indices ? DeepRead.PageRange.normalized(options.indices,this.count)
        : whole ? Array.from({length:this.count}, (_,i) => i) : [start];
      const layout = options.layout || (scope.startsWith("dual-") ? "parallel" : "mono");
      const bilingual = layout !== "mono", translationFirst = bilingual && !!options.translationFirst;
      const toLibrary = options.destination === "library";
      const exporter = DeepRead.ParallelExport;
      const output = exporter.description(this,indices,layout,translationFirst);
      const token = this.exportJob = new AbortController(), signal = token.signal;
      const signatures = [];
      let tmpPath, libraryPath, message = "";
      try {
        if (toLibrary) {
          const lib = Zotero.Libraries.get(this.session.item.libraryID);
          if (!lib.editable || !lib.filesEditable)
            throw new Error(tr("当前文库不能添加附件，请选择保存文件。", "This library cannot accept files. Choose Save to file."));
          path = libraryPath = PathUtils.join(PathUtils.tempDir, "deepread-export-"+crypto.randomUUID()+".pdf");
        } else if (!path) {
          path = await exporter.choose(this,output.name);
          if (!path) return false;
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
        const facing = bilingual ? await DeepRead.ParallelPDF.facingDocument(pdf,this,source,{layout,translationFirst}) : null;
        for (const i of indices) {
          if (signal.aborted) return false;
          await this.showPage(i, token);
          if (signal.aborted) return false;
          if (!this.page?.units) throw new Error(this.status.textContent);
          if (this.needsParse() || this.page.units.some((u) => !u.translation))
            throw new Error(
              tr(
                `第 ${i + 1} 页还有待译内容，请先翻译再保存。`,
                `Page ${i + 1} has untranslated content. Translate it before saving.`
              )
            );
          this.translateButton.disabled = true;
          this.bookButton.disabled = false;
          this.status.textContent = tr(`正在保存第 ${i + 1} 页…`, `Saving page ${i + 1}…`);
          if (toLibrary) signatures.push(await exporter.digest([this.page.index, this.page.view, this.page.transform,
            this.page.styleProfile?.roles, PLAN.records(this.page.units)]));
          await DeepRead.ParallelPDF.append(pdf, this, signal, facing);
        }
        if (signal.aborted) return false;
        if (facing) await facing.finish(signal);
        if (signal.aborted) return false;
        const bytes = await pdf.save();
        if (signal.aborted) return false;
        tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
        await IOUtils.write(path, Uint8Array.from(bytes), { tmpPath });
        if (toLibrary) {
          if (signal.aborted) return false;
          const item = await exporter.attach(this,path,output,current.fingerprint,[current.language,layout,translationFirst,signatures]);
          message = tr("译稿已加入 Zotero 文库", "PDF added to the Zotero library");
          return item;
        }
        message = bilingual ? tr("已保存双语对照 PDF","Bilingual PDF saved") : tr("已保存译文 PDF", "Translated PDF saved");
        return true;
      } finally {
        if (tmpPath) await IOUtils.remove(tmpPath, { ignoreAbsent: true });
        if (libraryPath) await IOUtils.remove(libraryPath, { ignoreAbsent: true });
        if (this.exportJob === token) {
          this.releaseSurface(this.exportSurface);this.exportSurface=null;this.exportJob=null;
          this.bookButton.textContent=tr("翻译全文","Translate all pages");
          await this.showPage(this.native.active ?? start,null,true);
          this.refreshExport();this.native?.schedule();
          if(message || signal.aborted)this.status.textContent=message || tr("已停止导出","Export stopped");
        }
      }
    }

    paint() {
      if(!this.surface?.page)return;
      this.paintSurface(this.surface);
      if(!this.book && !this.exportJob)this.updateStatus();
    }

    paintSurface(surface) {
      if(surface.nativeLayer)this.native?.mount(surface);
      const {page, source, target, extra, doc:hdoc}=surface, canvas=target.canvas;
      const ctx = canvas.getContext("2d"); ctx.drawImage(source.canvas, 0, 0);
      page.sharpened=null;
      target.stage.replaceChildren(canvas); extra.replaceChildren();
      const kx = canvas.width / page.width, ky = canvas.height / page.height;
      const pixels = page.units.some((u) => u.translation) ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
      const notes = [], frames=[];
      page.supplements=[];
      page.dirtyRects=[];
      for (const u of page.units) {
        if (!u.translation) continue;
        const type=page.styleProfile?.roles[u.typeRole];
        const rects = u.placed ? u.masks.map((r) => project(r, page.transform)) : [];
        const patches=u.verifiedLabel && u.placed ? u.masks.map(mask=>DeepRead.ParallelInk.labelPatch(pixels,mask,page,u.size)) : [];
        const colors = rects.map((r,i) => u.verifiedLabel ? patches[i]?.color : paperColor(pixels, r, kx, ky));
        const originalFragment = hdoc.importNode(this.session.overlay._translationContent(u, u.translation, page.language), true);
        let fragment = materialize(hdoc,originalFragment,u,page,source.canvas,pixels);
        if (type?.role.endsWith("Caption")) DeepRead.PaperStyles.captionLabel(fragment);
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
        if (u.markerRect && !type) {
          const m=project(u.markerRect,page.transform), x=Math.max(0,Math.floor(m.left*kx)-1), y=Math.max(0,Math.floor(m.top*ky)-1);
          const w=Math.ceil((m.left+m.width)*kx)-x+1, ht=Math.ceil((m.top+m.height)*ky)-y+1;
          ctx.drawImage(source.canvas,x,y,w,ht,x,y,w,ht);
        }
        const originalRect = project(u.rect, page.transform), r = {...originalRect};
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
        target.stage.append(block);
        if (type) layoutUnit={...layoutUnit,allItalic:false,title:type.weight===700,
          boldTitle:type.weight===700,caption:type.role.endsWith("Caption"),centered:["documentTitle","heading","subheading","metadata"].includes(type.role) && u.centered};
        const metrics=DeepRead.ParallelTypeset.draw(block, layoutUnit, fragment,
          u.size*Math.hypot(page.transform[0],page.transform[1]),type);
        frames.push({unit:u,block,angle,rect:{...r,height:r.height+(angle===0&&!u.title?u.clearance||0:0)},style:type,metrics});
        if (block.dataset.overflow) page.supplements.push(u);
        block.dataset.sourceRect=[originalRect.left,originalRect.top,originalRect.width,originalRect.height].join(" ");
      }
      DeepRead.ParallelFlow.render(frames,page,canvas);
      if (notes.length) {
        const detail = h(hdoc, "details", "dr-parallel-unplaced"); detail.open = true;
        detail.append(h(hdoc, "summary", "", tr(`单独显示的译文（${notes.length}）`, `Translations outside the page (${notes.length})`)));
        for (const [u, frag] of notes) {
          const row = h(hdoc, "div", "dr-parallel-passage");
          const translated = h(hdoc, "div");
          DeepRead.PaperType.apply(translated, page.language);
          const type=page.styleProfile?.roles[u.typeRole];
          if (type) DeepRead.PaperStyles.apply(translated,type,4/3);
          translated.append(frag);
          row.append(h(hdoc, "div", "", u.source), translated); detail.append(row);

        }
        extra.append(detail);
      }
      page.unplaced=notes.length;
      this.native?.painted(surface);
    }

    updateStatus() {
      const page=this.page, notes=page.unplaced || 0;
      const total = page.units.length, translated = page.units.filter((u) => u.translation).length;
      this.refreshExport();
      this.retryParse.hidden = !(page.partial ? page.partial.fallback : this.parsed?.fallback) || !!this.session.data?.contentList?.length;
      const pendingDownload = (page.partial || this.parsed)?.downloadJob;
      this.retryParse.textContent = pendingDownload ? tr("重试结果下载","Retry result download") : tr("重试解析服务","Retry parser");
      this.retryParse.disabled = !!this.book || !!this.exportJob || !!page.busy;
      const parse = this.needsParse();
      this.translateButton.hidden = translated === total && !parse && (!this.parsed?.legacy || page.partial) && !page.imageCandidates?.length;
      this.translateButton.disabled = !!this.book || !!this.exportJob || !!page.busy; this.bookButton.disabled = !!page.busy;
      this.translateButton.textContent = this.parsed?.legacy && !page.partial ? tr("补全版面并翻译本页","Refresh layout and translate page")
        : parse ? tr("解析并翻译本页", "Parse and translate page") : tr("翻译本页", "Translate page");
      this.status.textContent = parse ? tr("翻译本页时，解析服务只会收到这一页。", "Translate page sends only this page to your configured parser.")
        : total ? tr(`第 ${page.index + 1} 页 · 原位 ${translated-notes}/${total} 处`, `Page ${page.index + 1} · ${translated-notes}/${total} in place`)
          + (notes ? tr(` · 单独显示 ${notes} 处`, ` · ${notes} separate`) : '')
          + (page.supplements.length>notes ? tr(` · 长段全文 ${page.supplements.length-notes} 处`, ` · ${page.supplements.length-notes} full passages`) : '')
          + (total>translated ? tr(` · 待译 ${total-translated} 处`, ` · ${total-translated} pending`) : '')
        : tr("本页保留原图。扫描正文需要可用的 OCR 解析结果。", "Original page shown. Scanned text needs OCR results.");
      if (page.partial ? page.partial.fallback : this.parsed?.fallback) this.status.textContent += pendingDownload
        ? tr(" · MinerU 结果未能下载，当前使用 PDF 文字层"," · MinerU download unavailable, using the PDF text layer")
        : tr(" · 本次使用 PDF 文字层"," · Using PDF text layer");
      if (page.figureError) this.status.textContent+=tr(" · 图内文字识别未完成，保留原图"," · Figure text unavailable, original artwork shown");
      else if (page.imageCandidates?.length) this.status.textContent+=tr(" · 图内文字待识别"," · Figure labels pending");
    }

    openPassages(surface) {
      this.passageDialog?.close();
      const doc = this.doc,
        dialog = (this.passageDialog = h(doc, "dialog", "dr-translation-options dr-native-passages"));
      const title = h(doc, "h2", "", tr("完整译文 · 第 ", "Full passages · Page ") + (surface.index + 1));
      dialog.setAttribute("aria-label", title.textContent);
      dialog.append(title);
      const { page } = surface,
        canvas = surface.source.canvas;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      for (const u of page.supplements) {
        const body = h(doc, "p");
        DeepRead.PaperType.apply(body, page.language);
        const fragment = doc.importNode(
          this.session.overlay._translationContent(u, u.translation, page.language),
          true
        );
        body.append(materialize(doc, fragment, u, page, canvas, pixels));
        dialog.append(body);
      }
      const close = h(doc, "button", "", tr("关闭", "Close"));
      close.onclick = () => dialog.close();
      dialog.append(close);
      this.root.append(dialog);
      dialog.addEventListener(
        "close",
        () => {
          dialog.remove();
          if (this.passageDialog === dialog) this.passageDialog = null;
        },
        { once: true }
      );
      dialog.showModal();
      close.focus();
    }

  };
})();

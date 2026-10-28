/*
 * One Session per open PDF reader: loads cached results, runs the pipeline, owns the overlay,
 * and notifies panes/toolbar through a tiny listener API.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Components, IOUtils, PathUtils, ChromeUtils */

(function () {
  const sessions = new Map(); // ReaderInstance → Session
  let notifierID = null;

  function waived(obj) {
    return obj?.wrappedJSObject || obj;
  }

  /**
   * Chrome-side facade over the reader's pdf.js objects. Arguments are cloned into the content
   * compartment and page data is copied out as plain JSON (much faster to iterate than x-rays).
   */
  function createPdfAdapter(view) {
    const win = view._iframeWindow;
    const app = waived(win).PDFViewerApplication;
    const clone = (value) => Components.utils.cloneInto(value, win);
    const copyOut = (value) => JSON.parse(win.JSON.stringify(value));
    const doc = app.pdfDocument;
    // pageIndex → { viewport: { viewBox, originalViewBox, width, height } }; filled by prepareGeometry().
    const geometry = [];
    const pageViews = [];
    return {
      async prepareGeometry() {
        for (let i = 0; i < doc.numPages; i++) {
          if (geometry[i]) continue;
          const page = waived(await doc.getPage(i + 1));
          const view = Array.from(page.view);
          const viewport = { viewBox: view, originalViewBox: view, width: view[2] - view[0], height: view[3] - view[1] };
          geometry[i] = viewport;
          pageViews[i] = { viewport, originalPage: { viewport, div: null }, div: null };
        }
      },
      pdfDocument: {
        get numPages() {
          return doc.numPages;
        },
        async getPageData(params) {
          return copyOut(await doc.getPageData(clone({ pageIndex: params.pageIndex })));
        },
        async getPage(pageNumber) {
          const page = waived(await doc.getPage(pageNumber));
          return {
            view: Array.from(page.view),
            rotate: page.rotate,
            getViewport(params) {
              const viewport = waived(page.getViewport(clone({ scale: params?.scale ?? 1 })));
              return {
                width: viewport.width,
                height: viewport.height,
                viewBox: Array.from(viewport.viewBox),
                originalViewBox: viewport.originalViewBox ? Array.from(viewport.originalViewBox) : undefined,
                transform: Array.from(viewport.transform),
              };
            },
          };
        },
        async getOutline() {
          const outline = await doc.getOutline();
          return outline ? copyOut(outline) : null;
        },
      },
      pdfViewer: {
        get pagesCount() {
          return app.pdfViewer.pagesCount;
        },
        getPageView(index) {
          return pageViews[index] || null;
        },
        get _pages() {
          return pageViews;
        },
        get currentScale() {
          return app.pdfViewer.currentScale;
        },
      },
    };
  }

  DeepRead.Session = class Session {
    static forReader(reader) {
      if (!reader || reader.type !== "pdf") return null;
      let session = sessions.get(reader);
      if (!session) {
        session = new Session(reader);
        sessions.set(reader, session);
        Session._ensureNotifier();
      }
      return session;
    }

    static forWindow(win) {
      const tabID = win?.Zotero_Tabs?.selectedID;
      if (!tabID) return null;
      const reader = Zotero.Reader.getByTabID(tabID);
      return reader ? Session.forReader(reader) : null;
    }

    static forEachOverlay(fn) {
      for (const session of sessions.values()) fn(session.overlay);
    }

    static destroyAll() {
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
      if (notifierID) {
        Zotero.Notifier.unregisterObserver(notifierID);
        notifierID = null;
      }
    }

    static _ensureNotifier() {
      if (notifierID) return;
      notifierID = Zotero.Notifier.registerObserver({
        notify(event, type, ids) {
          if (type !== "tab" || event !== "close") return;
          for (const [reader, session] of sessions) {
            if (ids.includes(reader.tabID)) {
              session.destroy();
              sessions.delete(reader);
            }
          }
        },
      }, ["tab"], "deepread");
    }

    constructor(reader) {
      this.reader = reader;
      this.status = "idle"; // idle | loading | running | ready | error
      this.progress = { percent: 0, message: "" };
      this.error = null;
      this.data = null; // { hierarchicalData, articleSummary, blockMapping, sections, markdown, contentList, resultDir }
      this.userState = { pointImportance: {} };
      this.chat = null; // loaded lazily by the chat pane
      this.pendingQuotes = [];
      this.outlineStatus = "idle"; // idle | running | error
      this.summaryStatus = "idle";
      this._listeners = new Set();
      this._abort = null;
      this.overlay = new DeepRead.Overlay(this);
      this.rail = DeepRead.Rail ? new DeepRead.Rail(this) : null;
      this.structureBar = DeepRead.StructureBar ? new DeepRead.StructureBar(this) : null;
      this.figureGuides = {}; // figure id → { title, steps: [{ text, panel }] }
      this.questions = null; // { items: [{ id, question, answer, keys, custom?, at }], at } — question-led reading
      this.guide = null; // 带读: { position, skeleton, method, evidence, takeaway, markdown: { xray, card }, meta }
      this.guideRun = null; // { status: "running" | "structuring" | "error", startedAt, log, error }
      // paragraph key → { text, role, at, members?, title? }: the "AI 讲解" shown as the card body. A card that
      // covers several consecutive paragraphs is stored on its first (lead) key with `members`; the other
      // members only hold { lead, role, at }.
      this.explanations = {};
      this.explaining = new Set(); // keys being generated
      this._explainAbort = null;
      this.on((event) => {
        if (event === "explanations" && this.overlay.options.highlights) this.overlay.renderAllPages();
        if (event === "change" || event === "explanations") this._skim = null;
        if (event === "change" || event === "explanations" || event === "figures" || event === "figure-notes" || event === "questions") this.rail?.refresh();
        if (event === "questions" || event === "skim") this.structureBar?.refresh();
        if (event === "skim" || (event === "explanations" && this.skimDepth !== "full")) {
          this.overlay.renderAllPages();
          this.rail?.refresh();
        }
        if (event === "change") this.structureBar?.refresh();
      });
    }

    get item() {
      return Zotero.Items.get(this.reader.itemID);
    }

    get key() {
      return DeepRead.util.attachmentKey(this.item);
    }

    get parentItem() {
      const item = this.item;
      return item?.parentItemID ? Zotero.Items.get(item.parentItemID) : item;
    }

    get hasResults() {
      return !!this.data?.hierarchicalData?.length;
    }

    on(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    _emit(event = "change", payload = null) {
      if (event === "change" || event === "explanations") { this._cardGroups = null; this._suggestedHighlights = null; this._automaticHighlights = null; }
      for (const listener of [...this._listeners]) {
        try {
          listener(event, payload, this);
        }
        catch (e) {
          DeepRead.log("listener failed", String(e));
        }
      }
    }

    /** Idempotent: wait for the PDF view, attach overlay, load cached results. */
    init() {
      if (!this._initPromise) {
        this._initPromise = this._init().catch((e) => {
          DeepRead.log("session init failed", String(e));
          this._initPromise = null;
        });
      }
      return this._initPromise;
    }

    async _init() {
      this.status = "loading";
      this._emit();
      await this.reader._initPromise;
      const internal = waived(this.reader._internalReader);
      const view = internal?._primaryView;
      if (!view) throw new Error("no primary view");
      await view.initializedPromise;
      this.view = view;

      const stored = await DeepRead.Store.getPaper(this.key);
      this.userState = { pointImportance: {}, ...(stored?.user_state || {}) };
      if (stored?.hierarchical_data) {
        this.data = {
          hierarchicalData: stored.hierarchical_data,
          articleSummary: stored.article_summary,
          blockMapping: stored.block_mapping,
          sections: stored.sections,
          markdown: stored.markdown || "",
          contentList: stored.content_list,
          resultDir: stored.result_dir,
          language: stored.language,
        };
        this.explanations = stored.explanations || {};
        this.figureGuides = stored.figure_guides || {};
        this.questions = stored.questions || null;
        this.guide = stored.guide || null;
        this.status = "ready";
      }
      else {
        this.status = "idle";
      }
      this.overlay.attach(view);
      this.applyModules({ refresh: false });
      if (this.data) this.overlay.setData(this.data.hierarchicalData);
      this.rail?.attach(view);
      this.structureBar?.attach(view);
      this.lookup = DeepRead.Lookup ? new DeepRead.Lookup(this) : null;
      this.lookup?.attach(view);
      this.guidePanel = DeepRead.GuidePanel ? new DeepRead.GuidePanel(this) : null;
      this.guidePanel?.attach(view);
      // Papers read before v0.9: write the questions once, in the background.
      if (this.data) this._autoGenerate();
      // Highlighter colours change the PDF highlights and the cards' key points.
      this._prefObservers = [Zotero.Prefs.registerObserver("deepread.highlight.colors", () => {
        this.overlay.renderAllPages();
        this.rail?.refresh();
      }), Zotero.Prefs.registerObserver("deepread.cards.groupParagraphs", () => {
        this._cardGroups = null;
        this.rail?.refresh();
      })];
      this._emit();
    }

    destroy() {
      this._continuationAbort?.abort();
      this._guideAbort?.abort();
      this.guidePanel?.detach();
      this._questionsAbort?.abort();
      this.lookup?.detach();
      for (const id of this._prefObservers || []) Zotero.Prefs.unregisterObserver(id);
      this._prefObservers = [];
      this.cancel();
      this._explainAbort?.abort();
      this._figureAbort?.abort();
      this.structureBar?.detach();
      this.rail?.detach();
      this.overlay.detach();
      this._listeners.clear();
    }

    pdfAdapter() {
      return createPdfAdapter(this.view);
    }

    /* ---------- configuration checks ---------- */

    _checkConfig({ parser = true } = {}) {
      if (!DeepRead.LLM.isConfigured()) {
        throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      }
      if (parser && !DeepRead.Parser.isConfigured()) {
        throw Object.assign(new Error(DeepRead.t("error.noParser")), { configError: true });
      }
    }

    _newPipeline(signal, onProgress) {
      const adapter = this.pdfAdapter();
      return new DeepRead.Pipeline({
        getPdfApp: () => adapter,
        llm: (options) => DeepRead.LLM.complete({ ...options, signal: options.signal || signal }),
        parsePDF: async ({ onStatus } = {}) => {
          const filePath = await this.item.getFilePathAsync();
          if (!filePath) throw new Error(DeepRead.bilingual("找不到 PDF 文件", "PDF file not found"));
          return DeepRead.Parser.parsePDF({ filePath, attachmentKey: this.key, onStatus, signal, pdfApp: adapter });
        },
        onProgress: onProgress || (() => {}),
        notify: (message, type) => this._notify(message, type),
        language: DeepRead.prefs.language(),
        paperTitle: this.parentItem?.getField?.("title") || "",
        concurrency: DeepRead.prefs.llmConfig().concurrency,
        filterAuthors: DeepRead.prefs.get("filterAuthorBlocks") !== false,
        signal,
      });
    }

    _notify(message, type = "info") {
      DeepRead.log(`[${type}] ${message}`);
      this._emit("notify", { message, type });
    }

    _setProgress(next) {
      this.progress = {
        percent: typeof next.percent === "number" ? next.percent : this.progress.percent,
        message: next.message ?? this.progress.message,
      };
      this._emit("progress");
    }

    /* ---------- main flow ---------- */

    async run() {
      this._continuationAbort?.abort();
      if (this.status === "running") {
        this._notify(DeepRead.t("flow.busy"), "warning");
        return false;
      }
      await this.init();
      if (this.item?.attachmentContentType !== "application/pdf") {
        throw new Error(DeepRead.t("error.notPDF"));
      }
      this._checkConfig();

      const controller = new AbortController();
      this._abort = controller;
      this.status = "running";
      this.error = null;
      this.progress = { percent: 1, message: DeepRead.t("flow.start") };
      this._emit();
      try {
        const pipeline = this._newPipeline(controller.signal, (p) => this._setProgress(p));
        const result = await pipeline.run();
        this._setProgress({ percent: 97, message: DeepRead.t("flow.saving") });
        const data = {
          hierarchicalData: DeepRead.Session.compactHierarchicalData(result.hierarchicalData),
          articleSummary: result.articleSummary?.article_summary ?? result.articleSummary ?? null,
          blockMapping: result.blockMapping || null,
          sections: null,
          markdown: result.markdown || "",
          contentList: result.contentList || null,
          resultDir: result.resultDir || null,
          language: DeepRead.prefs.language(),
        };
        const userState = DeepRead.Reading.carryState(this.userState, this.data?.hierarchicalData, data.hierarchicalData);
        clearTimeout(this._saveUserStateTimer);
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          result_dir: data.resultDir,
          language: data.language,
          content_list: data.contentList,
          hierarchical_data: data.hierarchicalData,
          article_summary: data.articleSummary,
          block_mapping: data.blockMapping,
          sections: null,
          markdown: data.markdown,
          user_state: userState,
        });
        this.data = data;
        this.userState = userState;
        this._explainAbort?.abort();
        this._figureAbort?.abort();
        this.explanations = {};
        this.explaining.clear();
        this.figureGuides = {};
        this._figuresRequested = false;
        this._questionsAbort?.abort();
        this.questions = null;
        this._questionsRequested = false;
        this._continuationsRequested = false;
        this._refs = null;
        this._skim = null;
        this.overlay.setData(data.hierarchicalData);
        this.status = "ready";
        this.progress = { percent: 100, message: DeepRead.t("flow.done") };
        this._emit();
        // Card bodies: AI explanations fill in page by page after the deep read.
        if (DeepRead.prefs.get("cards.autoExplain") !== false) {
          this.explainAll().catch((e) => DeepRead.log("explanations failed", String(e)));
        }
        this._autoGenerate({ afterRun: true });
        if (DeepRead.Modules.enabled(this, "figureCards")) {
          this.explainFigures().catch((e) => DeepRead.log("figure guides failed", String(e)));
        }
        return true;
      }
      catch (error) {
        const aborted = controller.signal.aborted || error?.name === "AbortError";
        this.status = this.data ? "ready" : "idle";
        this.error = aborted ? null : error;
        this.progress = {
          percent: 0,
          message: aborted ? DeepRead.t("flow.cancelled") : DeepRead.t("flow.failed", { error: DeepRead.util.formatError(error) }),
        };
        if (!aborted) {
          DeepRead.log("run failed", error?.stack || String(error));
          this.status = this.data ? "ready" : "error";
        }
        this._emit();
        if (!aborted) throw error;
        return false;
      }
      finally {
        this._abort = null;
      }
    }

    cancel() {
      this._abort?.abort();
    }

    _pipelineWithState(signal) {
      const pipeline = this._newPipeline(signal);
      pipeline.loadState({
        resultDir: this.data.resultDir,
        contentList: this.data.contentList,
        markdown: this.data.markdown,
        hierarchicalData: this.data.hierarchicalData,
        articleSummary: this.data.articleSummary,
        blockMapping: this.data.blockMapping,
        sections: this.data.sections,
      });
      return pipeline;
    }

    async generateOutline() {
      await this.init();
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      this._checkConfig({ parser: false });
      this.outlineStatus = "running";
      this._emit();
      try {
        const pipeline = this._pipelineWithState(undefined);
        const outline = await pipeline.generateOutline();
        this.data.sections = outline;
        if (!this.data.blockMapping) this.data.blockMapping = pipeline.getState().blockMapping;
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          sections: outline,
          block_mapping: this.data.blockMapping,
        });
        this.outlineStatus = "idle";
        this._emit();
        return outline;
      }
      catch (error) {
        this.outlineStatus = "error";
        this.outlineError = DeepRead.util.formatError(error);
        this._emit();
        throw error;
      }
    }

    async regenerateSummary() {
      await this.init();
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      this._checkConfig({ parser: false });
      this.summaryStatus = "running";
      this._emit();
      try {
        const pipeline = this._pipelineWithState(undefined);
        const result = await pipeline.regenerateArticleSummary();
        this.data.articleSummary = result.articleSummary?.article_summary ?? result.articleSummary;
        if (result.blockMapping) this.data.blockMapping = result.blockMapping;
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          article_summary: this.data.articleSummary,
          block_mapping: this.data.blockMapping,
        });
        this.summaryStatus = "idle";
        this._emit();
      }
      catch (error) {
        this.summaryStatus = "error";
        this.summaryError = DeepRead.util.formatError(error);
        this._emit();
        throw error;
      }
    }

    async clearResults() {
      this._continuationAbort?.abort();
      this._guideAbort?.abort();
      this.guide = null;
      this.guideRun = null;
      this.cancel();
      this._explainAbort?.abort();
      this._figureAbort?.abort();
      this._questionsAbort?.abort();
      this.questions = null;
      this._questionsRequested = false;
      this._refs = null;
      this._skim = null;
      this.figureGuides = {};
      this._figuresRequested = false;
      this.explanations = {};
      this.explaining.clear();
      await DeepRead.Store.deletePaper(this.key);
      this.data = null;
      this.chat = null;
      this.userState = { pointImportance: {} };
      this.status = "idle";
      this.progress = { percent: 0, message: "" };
      this.overlay.setData([]);
      this._emit();
    }

    /** Push the paper's module switches (DeepRead.Modules) into the overlay, rail and section bar. */
    applyModules({ refresh = true } = {}) {
      const M = DeepRead.Modules;
      this.overlay.setOptions?.({
        highlights: M.enabled(this, "highlights"),
        translationPopup: M.enabled(this, "hoverTranslation"),
      });
      if (refresh) {
        this.overlay.renderAllPages?.(); // skim layers
        this.rail?.refresh();
        this.structureBar?.refresh();
        this._autoGenerate(); // a module just switched on may need its questions
      }
      this._emit("modules");
    }

    /* ---------- figures and tables (module "figureCards") ---------- */

    /** Captioned figures/tables of the paper (DeepRead.Figures.list), cached per content list. */
    figures() {
      const list = this.data?.contentList;
      if (!Array.isArray(list) || !DeepRead.Figures) return [];
      if (this._figuresFor !== list) {
        this._figuresFor = list;
        this._figures = DeepRead.Figures.list(list);
        this._figureMentions = DeepRead.Figures.mentions(this._figures, list);
      }
      return this._figures;
    }

    figureMentionCount(id) {
      this.figures();
      return this._figureMentions?.get(id)?.length || 0;
    }

    figureGuide(id) {
      return this.figureGuides?.[id] || null;
    }

    get explainingFigures() {
      return !!this._explainingFigures;
    }

    /** Write "how to read this figure" guides for figures that have none (or all, with force). */
    async explainFigures({ force = false } = {}) {
      if (!this.hasResults || this._explainingFigures || !DeepRead.LLM.isConfigured()) return 0;
      const figures = this.figures().filter((f) => force || !this.figureGuides?.[f.id]);
      if (!figures.length) return 0;
      const controller = new AbortController();
      this._figureAbort = controller;
      this._explainingFigures = true;
      this._emit("figures");
      try {
        const guides = await DeepRead.Figures.explain(figures, {
          contentList: this.data.contentList,
          mentions: this._figureMentions,
          targetLang: DeepRead.prefs.language(),
          paperContext: this.paperContext(),
          signal: controller.signal,
        });
        this.figureGuides = { ...this.figureGuides, ...Object.fromEntries(guides) };
        await DeepRead.Store.savePaper(this.key, this.item.id, { figure_guides: this.figureGuides });
        return guides.size;
      }
      finally {
        this._explainingFigures = false;
        this._emit("figures");
      }
    }

    /* ---------- v0.9: questions, references, skim ---------- */

    /**
     * After a deep read (or when an older paper is opened): questions need the explanations, so they wait for
     * them. Each runs once per session unless forced.
     */
    _autoGenerate({ afterRun = false } = {}) {
      if (!this.hasResults || !DeepRead.LLM.isConfigured()) return;
      if (!this._continuationsRequested && this.data.hierarchicalData.some((p) => p.paragraphs?.some((x) => !x.continuationChecked))) {
        this._continuationsRequested = true;
        this.mergeContinuationTranslations().catch((e) => DeepRead.log("joining interrupted paragraphs failed", String(e)));
      }

      if (DeepRead.Modules.enabled(this, "questions") && !this.questions?.items?.length && !this._questionsRequested) {
        this._questionsRequested = true;
        const start = () => this.generateQuestions().catch((e) => DeepRead.log("questions failed", String(e)));
        if (afterRun || this.explaining.size) {
          // Let the explanations (roles, merged cards) land first; give up waiting after 3 minutes.
          const begun = Date.now();
          const wait = () => {
            if (!this.hasResults) return;
            if (this.explaining.size && Date.now() - begun < 180000) setTimeout(wait, 1500);
            else start();
          };
          setTimeout(wait, 1500);
        }
        else start();
      }
    }

    /** Paragraph cards as "blocks" for the questions prompts. */
    blocks() {
      const out = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          if (!String(paragraph.paragraphType || "text").startsWith("text") && paragraph.paragraphType !== "list") continue;
          const key = `p_${page.pageIndex}_${paragraph.paragraphIndex}`;
          out.push({
            key,
            label: `p. ${page.pageIndex + 1} ¶${paragraph.paragraphIndex + 1}`,
            summary: this.paragraphSummary({ ...paragraph, pageIndex: page.pageIndex }),
            explanation: this.explanation(key),
            role: this.paragraphRole(key),
            text: paragraph.paragraphText || "",
          });
        }
      }
      return out;
    }

    _saveSoon(field) {
      this._saveTimers = this._saveTimers || {};
      clearTimeout(this._saveTimers[field]);
      this._saveTimers[field] = setTimeout(() => {
        DeepRead.Store.savePaper(this.key, this.item.id, { [field]: this[field] })
          .catch((e) => DeepRead.log(`saving ${field} failed`, String(e)));
      }, 400);
    }

    get generatingQuestions() {
      return !!this._questionsBusy;
    }

    /** The five reading questions (the reader's own questions are kept). */
    async generateQuestions() {
      if (!this.hasResults || this._questionsBusy) return null;
      if (!DeepRead.LLM.isConfigured()) throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      const controller = new AbortController();
      this._questionsAbort = controller;
      this._questionsBusy = true;
      this._emit("questions");
      try {
        const items = await DeepRead.Questions.generate({
          blocks: this.blocks(),
          paperContext: this.paperContext(),
          targetLang: DeepRead.prefs.language(),
          signal: controller.signal,
        });
        const custom = (this.questions?.items || []).filter((q) => q.custom);
        const at = Date.now();
        this.questions = { items: [...items.map((q) => ({ ...q, at })), ...custom], at };
        this._saveSoon("questions");
        return this.questions;
      }
      finally {
        this._questionsBusy = false;
        this._emit("questions");
      }
    }

    /** A question of the reader's own, answered from the paper's blocks. */
    async askQuestion(question) {
      const text = String(question || "").trim();
      if (!text || !this.hasResults) return null;
      if (!DeepRead.LLM.isConfigured()) throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      const item = { id: `u${Date.now().toString(36)}`, question: text, answer: "", keys: [], custom: true, pending: true, at: Date.now() };
      this.questions = { items: [...(this.questions?.items || []), item], at: this.questions?.at || Date.now() };
      this._emit("questions");
      try {
        const { answer, keys } = await DeepRead.Questions.ask(text, {
          blocks: this.blocks(),
          paperContext: this.paperContext(),
          targetLang: DeepRead.prefs.language(),
        });
        Object.assign(item, { answer, keys });
        return item;
      }
      catch (e) {
        this.questions.items = this.questions.items.filter((q) => q !== item);
        throw e;
      }
      finally {
        delete item.pending;
        this._saveSoon("questions");
        this._emit("questions");
      }
    }

    removeQuestion(id) {
      if (!this.questions) return;
      this.questions.items = this.questions.items.filter((q) => q.id !== id);
      this._saveSoon("questions");
      this._emit("questions");
    }

    /** Questions answered (in part) by a card's paragraphs. */
    questionsForKey(key) {
      const members = new Set(this.groupMembers(key));
      return (this.questions?.items || []).filter((q) => (q.keys || []).some((k) => members.has(this.groupLead(k)) || members.has(k)));
    }

    questionLabel(q) {
      const items = this.questions?.items || [];
      if (!q.custom) return q.id.toUpperCase();
      return `Q${items.filter((x) => !x.custom).length + items.filter((x) => x.custom).indexOf(q) + 1}`;
    }

    /** Position (page index + fraction) of a paragraph's top, or null. */
    keyPosition(key) {
      const found = this._paragraphByKey(key);
      if (!found) return null;
      const rect = found.paragraph.bbox;
      const geom = rect && this.overlay._geometry?.(found.page.pageIndex);
      const top = geom ? this.overlay._toPercent(geom, rect).top / 100 : 0.5;
      return found.page.pageIndex + Math.max(0, Math.min(0.99, top));
    }

    /** A question counts as reached once the reader has read past all of its answer's paragraphs. */
    questionReached(q) {
      const positions = (q.keys || []).map((k) => this.keyPosition(k)).filter((p) => p !== null);
      if (!positions.length) return false;
      return (this.userState.readUpTo || 0) >= Math.max(...positions);
    }

    questionProgress() {
      const items = (this.questions?.items || []).filter((q) => !q.pending);
      return { reached: items.filter((q) => this.questionReached(q)).length, total: items.length };
    }

    get skimDepth() {
      if (!DeepRead.Modules.enabled(this, "skim")) return "full";
      const depth = this.userState.skimDepth || DeepRead.prefs.get("skim.depth") || "full";
      return ["full", "key", "margin"].includes(depth) ? depth : "full";
    }

    setSkimDepth(depth) {
      this.userState.skimDepth = depth;
      this._saveUserStateSoon();
      this._emit("skim");
    }

    /** { tier: Map(key → key|normal|minor), keyPoints: Set(point ids) }, cached until the results change. */
    skimTiers() {
      if (!this._skim) {
        this._skim = DeepRead.Skim.tiers(this.data?.hierarchicalData || [], {
          role: (key) => this.paragraphRole(key) || this.paragraphRole(this.groupLead(key)),
        });
      }
      return this._skim;
    }

    /* ---------- 带读 (guided reading, ③ Agent channel) ---------- */

    get guideStatus() {
      return this.guideRun?.status || (this.guide ? "ready" : "empty");
    }

    /** Is the ③ Agent channel set up for a run (import needs no setup)? */
    agentConfigured() {
      const kind = DeepRead.prefs.get("agent.kind") || "none";
      if (kind === "api") return !!DeepRead.prefs.agentApiConfig().baseURL;
      return ["codex", "claude", "import"].includes(kind);
    }

    _guideLog(text) {
      if (!this.guideRun) return;
      this.guideRun.log = `${this.guideRun.log || ""}${text}`.slice(-6000);
      const now = Date.now();
      if (now - (this._guideLogEmitted || 0) > 500) {
        this._guideLogEmitted = now;
        this._emit("guide");
      }
    }

    _guideBlocks() {
      return this.blocks().map((b) => ({ key: b.key, label: b.label, summary: b.summary }));
    }

    /** Run the guided reading with the configured agent (kind "import" opens the file picker instead). */
    async runGuide() {
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      if (this.guideRun && this.guideRun.status !== "error") return null;
      const kind = DeepRead.prefs.get("agent.kind") || "none";
      if (kind === "import") return this.pickGuideFile();
      if (!this.agentConfigured()) {
        throw Object.assign(new Error(DeepRead.bilingual("先在 设置 → ③ Agent 里选择带读用的 Agent", "Choose an agent in Settings → ③ Agent first")), { configError: true });
      }
      const controller = new AbortController();
      this._guideAbort = controller;
      const startedAt = Date.now();
      this.guideRun = { status: "running", startedAt, log: "" };
      this._emit("guide");
      try {
        let markdown;
        let skills = [];
        let model = "";
        if (kind === "api") {
          const config = DeepRead.prefs.agentApiConfig();
          model = config.model;
          const found = await DeepRead.AgentRunner.findSkills(this._agentSkillNames());
          skills = found.map((s) => s.name);
          let skillsText = "";
          for (const s of found) skillsText += `\n\n# ${s.name}\n${await IOUtils.readUTF8(s.path).catch(() => "")}`;
          this._guideLog(DeepRead.bilingual(`远程 API · ${model || "?"}：正在写精读长文和精读卡…\n`, `Remote API · ${model || "?"}: writing the long-read and paper card…\n`));
          markdown = await DeepRead.Guide.writeWithApi({
            hierarchicalData: this.data.hierarchicalData,
            title: this.parentItem?.getField?.("title") || "",
            paperContext: this.paperContext(),
            targetLang: DeepRead.prefs.language(),
            config,
            signal: controller.signal,
            skillsText,
          });
        }
        else {
          const result = await this._runLocalAgent(kind, controller.signal);
          markdown = result.markdown;
          skills = result.skills;
        }
        if (!markdown.xray && !markdown.card) throw new Error(DeepRead.bilingual("Agent 没有给出结果", "The agent returned nothing"));
        await this._structureGuide(markdown, { kind, skills, model, startedAt, source: kind }, controller.signal);
        return this.guide;
      }
      catch (e) {
        if (controller.signal.aborted || e?.name === "AbortError") this.guideRun = null;
        else this.guideRun = { ...(this.guideRun || {}), status: "error", error: DeepRead.util.formatError(e) };
        throw e;
      }
      finally {
        if (this.guideRun?.status === "running" || this.guideRun?.status === "structuring") this.guideRun = null;
        this._emit("guide");
      }
    }

    _agentSkillNames() {
      return String(DeepRead.prefs.get("agent.skills") || "").split(",").map((s) => s.trim()).filter(Boolean);
    }

    /** Codex / Claude Code in a work directory under the data directory; returns its Markdown. */
    async _runLocalAgent(kind, signal) {
      const R = DeepRead.AgentRunner;
      const skills = await R.findSkills(this._agentSkillNames());
      const baseDir = PathUtils.join(Zotero.DataDirectory.dir, "deepread", "agent", this.key);
      const workdir = await R.prepareWorkdir({
        baseDir,
        files: { "paper.md": DeepRead.Guide.paperMarkdown(this.data.hierarchicalData, { title: this.parentItem?.getField?.("title") || "" }) },
      });
      const prompt = DeepRead.Guide.agentPrompt({
        workdir,
        pdfPath: (await this.item.getFilePathAsync?.()) || this.item.getFilePath?.() || "",
        skills,
        targetLang: DeepRead.prefs.language(),
      });
      const skillsDir = skills.length ? PathUtils.parent(PathUtils.parent(skills[0].path)) : "";
      const argv = R.buildArgv({ kind, command: String(DeepRead.prefs.get("agent.command") || "").trim(), prompt, workdir, skillsDir });
      if (!PathUtils.isAbsolute?.(argv.file) && !argv.file.startsWith("/")) {
        const exe = await R.findExecutable(argv.file);
        if (!exe) throw new Error(DeepRead.bilingual(`找不到命令 ${argv.file}（可在 设置 → ③ Agent 里填完整路径）`, `Command not found: ${argv.file} (set the full path in Settings → ③ Agent)`));
        argv.file = exe;
      }
      this._guideLog(`$ ${argv.file} … (${workdir})\n`);
      const timeoutMs = Math.max(1, DeepRead.prefs.number("agent.timeoutMin", 10)) * 60000;
      const result = await R.run({ argv, workdir, timeoutMs, signal, onOutput: (chunk) => this._guideLog(chunk) });
      if (result.aborted || signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      const collected = await R.collect(workdir);
      if (!collected.xray && !collected.card) {
        const why = result.timedOut ? DeepRead.bilingual("超时", "timed out") : DeepRead.bilingual(`退出码 ${result.exitCode}`, `exit code ${result.exitCode}`);
        throw new Error(DeepRead.bilingual(`Agent 没有写出 xray.md / paper-card.md（${why}）`, `The agent wrote neither xray.md nor paper-card.md (${why})`));
      }
      return { markdown: { xray: collected.xray, card: collected.card }, skills: skills.map((s) => s.name), workdir };
    }

    /** Stage B: the reading API turns the agent's Markdown into the five steps, linked to the paragraphs. */
    async _structureGuide(markdown, meta, signal) {
      this.guideRun = { ...(this.guideRun || { startedAt: Date.now(), log: "" }), status: "structuring" };
      this._guideLog(DeepRead.bilingual("整理成带读五步…\n", "Organising into the five steps…\n"));
      this._emit("guide");
      const guide = await DeepRead.Guide.structure({
        markdown,
        blocks: this._guideBlocks(),
        paperContext: this.paperContext(),
        targetLang: DeepRead.prefs.language(),
        signal,
      });
      this.guide = { ...guide, markdown, meta: { ...meta, finishedAt: Date.now() } };
      this.guideRun = null;
      this._saveSoon("guide");
      this._emit("guide");
      return this.guide;
    }

    /** Import an agent result produced elsewhere (Markdown or our guide JSON). */
    async importGuide(path) {
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      const text = await IOUtils.readUTF8(path);
      const parsed = DeepRead.Guide.parseImported(text, this._guideBlocks().map((b) => b.key));
      const meta = { kind: "import", skills: [], model: "", startedAt: Date.now(), source: PathUtils.filename(path) };
      if (parsed.guide) {
        this.guide = { ...parsed.guide, markdown: parsed.markdown, meta: { ...meta, finishedAt: Date.now() } };
        this._saveSoon("guide");
        this._emit("guide");
        return this.guide;
      }
      const controller = new AbortController();
      this._guideAbort = controller;
      this.guideRun = { status: "structuring", startedAt: Date.now(), log: "" };
      try {
        return await this._structureGuide(parsed.markdown, meta, controller.signal);
      }
      catch (e) {
        this.guideRun = controller.signal.aborted ? null : { status: "error", error: DeepRead.util.formatError(e), log: this.guideRun?.log || "" };
        throw e;
      }
      finally {
        this._emit("guide");
      }
    }

    async pickGuideFile() {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      fp.init(Zotero.getMainWindow(), DeepRead.bilingual("导入带读结果", "Import a guided-reading result"), fp.modeOpen);
      fp.appendFilter("Markdown / JSON", "*.md; *.markdown; *.json; *.txt");
      fp.appendFilters(fp.filterAll);
      if (await fp.show() !== fp.returnOK) return null;
      return this.importGuide(fp.file);
    }

    cancelGuide() {
      this._guideAbort?.abort();
    }

    /** Save the guided reading (five steps + paper card) as a child note of the paper. */
    async saveGuideNote() {
      if (!this.guide) return null;
      const parent = this.parentItem;
      const note = new Zotero.Item("note");
      note.libraryID = this.item.libraryID;
      if (parent && parent.id !== this.item.id) note.parentID = parent.id;
      note.setNote(DeepRead.Guide.toNoteHTML(this.guide, this.guide.markdown || {}, { title: parent?.getField?.("title") || "" }));
      await note.saveTx();
      return note;
    }

    guideMarkdown() {
      const md = this.guide?.markdown || {};
      return [md.xray, md.card].filter(Boolean).join("\n\n---\n\n");
    }

    /** Guided-reading notes for a card (load-bearing judgement, hedging, claim status). */
    guideNotesForKey(key) {
      if (!this.guide || !DeepRead.Guide || !DeepRead.Modules.enabled(this, "guided")) return [];
      const out = [];
      const seen = new Set();
      for (const k of this.groupMembers(key)) {
        for (const note of DeepRead.Guide.notesForKey(this.guide, k)) {
          const id = `${note.kind}|${note.label}|${note.text}`;
          if (!seen.has(id)) {
            seen.add(id);
            out.push(note);
          }
        }
      }
      return out;
    }

    /* ---------- AI explanations (card bodies) ---------- */

    async mergeContinuationTranslations() {
      if (!this.hasResults || !DeepRead.LLM.isConfigured() || this._joiningContinuations) return 0;
      const data = this.data, controller = new AbortController();
      this._continuationAbort = controller;
      this._joiningContinuations = true;
      try {
        const paragraphs = data.hierarchicalData.flatMap((page) => (page.paragraphs || []).map((p) => ({
          ...p, page_idx: page.pageIndex, paragraph_idx: p.paragraphIndex, paragraph_type: p.paragraphType, paragraph_text: p.paragraphText,
        })));
        // Old caches omit character mappings. Recover source emphasis locally for
        // candidate pages before asking for a joint translation.
        const units = DeepRead.Continuations.candidates(paragraphs, { visuals: data.contentList });
        if (units.length && this.view && DeepRead.Typography) {
          const adapter = this.pdfAdapter(), pages = new Map();
          for (const p of units.flatMap((u) => u.parts)) {
            if (controller.signal.aborted) return 0;
            try {
              if (!pages.has(p.page_idx)) {
                const page = await adapter.pdfDocument.getPageData({ pageIndex: p.page_idx });
                pages.set(p.page_idx, (page.chars || []).map((c, offset) => ({ ...c, offset })));
              }
              const chars = pages.get(p.page_idx), matched = DeepRead.Typography.match(chars, p.paragraph_text);
              if (matched) {
                const formatted = DeepRead.Pipeline.prototype._extractFormattedText(matched);
                p.sourceStyledText = DeepRead.Typography.styledSentence(formatted, chars);
                p.typography = DeepRead.Typography.metrics(matched) || p.typography;
              }
            }
            catch (e) { DeepRead.log("source styles unavailable for continuation", String(e)); }
          }
        }
        const result = await DeepRead.Continuations.reconcile(paragraphs, {
          complete: (options) => DeepRead.LLM.complete(options), targetLang: DeepRead.prefs.language(), signal: controller.signal,
          visuals: data.contentList,
        });
        if (controller.signal.aborted || this.data !== data) return 0;
        const byKey = new Map(result.paragraphs.map((p) => [`p_${p.page_idx}_${p.paragraph_idx}`, p]));
        const hierarchicalData = data.hierarchicalData.map((page) => ({ ...page, paragraphs: page.paragraphs.map((p) => {
          const updated = byKey.get(`p_${page.pageIndex}_${p.paragraphIndex}`);
          return { ...p, typography: updated.typography || p.typography, continuation: updated.continuation || null, continuationChecked: updated.continuationChecked };
        }) }));
        // Commit only if the user is still looking at these results (clear/rerun cancels).
        await DeepRead.Store.savePaper(this.key, this.item.id, { hierarchical_data: hierarchicalData });
        if (controller.signal.aborted || this.data !== data) return 0;
        this.data = { ...data, hierarchicalData };
        this._cardGroups = null;
        this.overlay.setData(hierarchicalData);
        this._emit("change");
        return result.count;
      }
      finally { this._joiningContinuations = false; }
    }

    continuationFor(paragraph) {
      const link = paragraph?.continuation;
      if (!link?.lead) return null;
      const entry = this._paragraphByKey(link.lead)?.paragraph?.continuation;
      if (!entry?.translation || !Array.isArray(entry.keys)) return null;
      const key = `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`;
      // Explicit manual splits take precedence over automatic translation grouping.
      const members = new Set(this.groupMembers(key));
      return entry.keys.includes(key) && entry.keys.every((k) => members.has(k)) ? entry : null;
    }

    explanation(key) {
      const seen = new Set();
      return this.groupMembers(key).map((member) => {
        const owner = this.explanations?.[member]?.lead || member;
        if (seen.has(owner)) return "";
        seen.add(owner);
        return this.explanations?.[owner]?.text || "";
      }).filter(Boolean).join("\n\n");
    }

    _cardGrouping() {
      if (!this._cardGroups) this._cardGroups = DeepRead.CardGroups.build(this.data?.hierarchicalData,
        this.explanations, this.userState.cardGroups, DeepRead.prefs.get("cards.groupParagraphs") !== false);
      return this._cardGroups;
    }

    groupLead(key) { return this._cardGrouping().leads.get(key) || key; }
    groupMembers(key) { return this._cardGrouping().groups.get(this.groupLead(key)) || [key]; }
    groupTitle(key) { return this.explanations?.[this.groupLead(key)]?.title || ""; }

    groupLabel(key) {
      const members = this.groupMembers(key).map((k) => /^p_(\d+)_(\d+)$/.exec(k)).filter(Boolean);
      if (!members.length) return key;
      const first = members[0], last = members.at(-1);
      const start = `p. ${Number(first[1]) + 1} ¶${Number(first[2]) + 1}`;
      if (first[1] !== last[1]) return `${start}–p. ${Number(last[1]) + 1} ¶${Number(last[2]) + 1}`;
      if (Number(last[2]) - Number(first[2]) + 1 !== members.length) return `p. ${Number(first[1]) + 1} ¶${members.map((m) => Number(m[2]) + 1).join(", ")}`;
      return first[2] === last[2] ? start : `${start}–${Number(last[2]) + 1}`;
    }

    previousCard(key) {
      const group = this._cardGrouping();
      const at = group.order.get(this.groupLead(key));
      const previous = group.rows[at - 1], current = group.rows[at];
      if (!DeepRead.CardGroups.textType(previous) || !DeepRead.CardGroups.textType(current)) return null;
      return this.groupLead(`p_${previous.pageIndex}_${previous.paragraphIndex}`);
    }

    mergeCardWithPrevious(key) {
      const previous = this.previousCard(key);
      if (!previous) return false;
      const members = [...this.groupMembers(previous), ...this.groupMembers(key)];
      const overrides = { ...(this.userState.cardGroups || {}) };
      for (const member of members) overrides[member] = [...members];
      this.userState.cardGroups = overrides;
      this._cardGroups = null;
      this._saveUserStateSoon();
      this.rail?.collapseAll();
      this._emit("explanations");
      return true;
    }

    splitCard(key) {
      const overrides = { ...(this.userState.cardGroups || {}) };
      for (const member of this.groupMembers(key)) overrides[member] = [member];
      this.userState.cardGroups = overrides;
      this._cardGroups = null;
      this._saveUserStateSoon();
      this.rail?.collapseAll();
      this._emit("explanations");
    }

    /** Store explanations from the explainer: Map(lead → text), roles, groups (lead → keys), titles. */
    _storeExplanations(map, roles, extra = {}) {
      this._cardGroups = null;
      const at = Date.now();
      let count = 0;
      for (const [lead, text] of map) {
        const members = extra.groups?.get(lead) || [lead];
        // Leaving an old merged card: its other members fall back to their own cards.
        for (const key of members) {
          const old = this.explanations[key];
          if (old?.members) for (const k of old.members) if (!members.includes(k) && this.explanations[k]?.lead === key) delete this.explanations[k];
        }
        const entry = { text, role: roles?.get(lead) || "", at };
        if (members.length > 1) {
          entry.members = [...members];
          const title = extra.titles?.get(lead);
          if (title) entry.title = title;
        }
        this.explanations[lead] = entry;
        for (const key of members.slice(1)) this.explanations[key] = { lead, role: roles?.get(key) || entry.role, at };
        for (const key of members) this.explaining.delete(key);
        count += members.length;
      }
      return count;
    }

    /** The paragraph's role in the argument (background / gap / prior / contribution / method / result / limitation). */
    paragraphRole(key) {
      return this.explanations?.[key]?.role || "";
    }

    isExplaining(key) {
      return this.explaining.has(key);
    }

    /** Title + abstract, given to the explainer as context. */
    paperContext() {
      const item = this.parentItem;
      if (!item?.isRegularItem?.()) return "";
      return [
        item.getField("title") ? `Title: ${item.getField("title")}` : "",
        item.getField("abstractNote") ? `Abstract: ${String(item.getField("abstractNote")).slice(0, 2000)}` : "",
      ].filter(Boolean).join("\n");
    }

    _paragraphByKey(key) {
      const m = /^p_(\d+)_(\d+)$/.exec(key || "");
      if (!m) return null;
      const page = (this.data?.hierarchicalData || []).find((p) => p.pageIndex === Number(m[1]));
      const paragraph = page?.paragraphs?.find((p) => p.paragraphIndex === Number(m[2]));
      return paragraph ? { page, paragraph } : null;
    }

    /** Paragraphs that can have an explanation but don't yet. */
    missingExplanations() {
      const keys = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          const key = DeepRead.Explainer.key(page.pageIndex, paragraph.paragraphIndex);
          if (DeepRead.Explainer.eligible(paragraph) && !this.explanation(this.groupLead(key)) && !this.explaining.has(key)) keys.push(key);
        }
      }
      return keys;
    }

    /** Generate missing explanations for the whole paper (or `only` those keys), page by page. */
    async explainAll({ only } = {}) {
      if (!this.hasResults || !DeepRead.LLM.isConfigured()) return 0;
      const keys = only ? [...only].filter((k) => !this.explaining.has(k)) : this.missingExplanations();
      if (!keys.length) return 0;
      const controller = this._explainAbort && !this._explainAbort.signal.aborted ? this._explainAbort : new AbortController();
      this._explainAbort = controller;
      for (const key of keys) this.explaining.add(key);
      this._emit("explanations");
      let count = 0;
      try {
        await DeepRead.Explainer.explainPages(this.data.hierarchicalData, {
          targetLang: DeepRead.prefs.language(),
          paperContext: this.paperContext(),
          only: new Set(keys),
          group: DeepRead.prefs.get("cards.groupParagraphs") !== false,
          signal: controller.signal,
          onPage: (_pageIndex, map, roles, extra) => {
            count += this._storeExplanations(map, roles, extra);
            this._saveExplanationsSoon();
            this._emit("explanations");
          },
        });
      }
      finally {
        for (const key of keys) this.explaining.delete(key);
        this._emit("explanations");
      }
      return count;
    }

    /** (Re)generate one card's explanation: a merged card is explained again as a group. */
    async explainParagraph(key) {
      key = this.groupLead(key);
      const members = this.groupMembers(key);
      if (members.length > 1) {
        if (members.some((k) => this.explaining.has(k))) return null;
        if (!DeepRead.LLM.isConfigured()) throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
        await this.explainAll({ only: members });
        return this.explanation(this.groupLead(key));
      }
      const found = this._paragraphByKey(key);
      if (!found || this.explaining.has(key)) return null;
      if (!DeepRead.LLM.isConfigured()) throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      const { page, paragraph } = found;
      const index = page.paragraphs.indexOf(paragraph);
      const neighbors = page.paragraphs.slice(Math.max(0, index - 2), index).map((p) => p.paragraphText || "").filter(Boolean);
      this.explaining.add(key);
      this._emit("explanations");
      try {
        const { text, role } = await DeepRead.Explainer.explainOne(paragraph, {
          pageIndex: page.pageIndex,
          targetLang: DeepRead.prefs.language(),
          paperContext: this.paperContext(),
          neighbors,
          withRole: true,
        });
        if (text) {
          this.explanations[key] = { text, role: role || this.explanations[key]?.role || "", at: Date.now() };
          this._saveExplanationsSoon();
        }
        return text;
      }
      finally {
        this.explaining.delete(key);
        this._emit("explanations");
      }
    }

    _saveExplanationsSoon() {
      clearTimeout(this._saveExplanationsTimer);
      this._saveExplanationsTimer = setTimeout(() => {
        DeepRead.Store.savePaper(this.key, this.item.id, { explanations: this.explanations })
          .catch((e) => DeepRead.log("saving explanations failed", String(e)));
      }, 800);
    }

    /* ---------- user state ---------- */

    setReadingGoal(kind, text = this.userState.readingGoal?.text || "", { notify = true } = {}) {
      const changedKind = this.userState.readingGoal?.kind !== (DeepRead.Reading.goal(kind)?.key || "");
      this.userState.readingGoal = { kind: DeepRead.Reading.goal(kind)?.key || "", text: String(text).slice(0, 1000) };
      this._saveUserStateSoon();
      if (changedKind) { this._automaticHighlights = null; this.overlay.renderAllPages(); }
      if (notify) this._emit("reading");
    }

    readingTargets() {
      return DeepRead.Reading.targets(this.userState.readingGoal?.kind,
        DeepRead.Structure.sections(this.data?.contentList), this.figures());
    }

    openReadingTarget(target) {
      if (target.kind === "section") {
        if (this.structureBar?.app) this.structureBar._goTo(target.section);
        else this.reader.navigate({ pageIndex: Math.floor(target.section.start) });
      }
      else if (target.kind === "figure") {
        const f = target.figure, rect = this.overlay.permilleRect(f.pageIndex, f.bbox);
        this.reader.navigate(rect ? { position: { pageIndex: f.pageIndex, rects: [rect] } } : { pageIndex: f.pageIndex });
      }
    }

    figureNote(id) { return this.userState.figureNotes?.[id] || null; }

    setFigureNote(figure, fields) {
      const note = { label: DeepRead.Rail.figureLabel(figure), caption: figure.caption || "", pageIndex: figure.pageIndex };
      for (const field of DeepRead.Reading.FIELDS) note[field.key] = String(fields[field.key] || "").trim().slice(0, 6000);
      const notes = { ...(this.userState.figureNotes || {}) };
      if (DeepRead.Reading.FIELDS.some((f) => note[f.key])) notes[figure.id] = note;
      else delete notes[figure.id];
      this.userState.figureNotes = notes;
      this._saveUserStateSoon();
      this._emit("figure-notes");
    }

    readingRecord() {
      const tr = DeepRead.bilingual;
      const title = this.parentItem?.getField?.("title") || tr("阅读记录", "Reading record");
      const lines = [`# ${title}`];
      const g = this.userState.readingGoal || {}, goal = DeepRead.Reading.goal(g.kind);
      if (goal || g.text) lines.push(`\n## ${tr("阅读目标", "Reading goal")}`, goal ? tr(goal.zh, goal.en) : "", g.text || "");
      for (const note of Object.values(this.userState.figureNotes || {})) {
        lines.push(`\n## ${note.label} · p.${note.pageIndex + 1}`, note.caption);
        for (const f of DeepRead.Reading.FIELDS) if (note[f.key]) lines.push(`\n${tr(f.zh, f.en)}`, note[f.key]);
      }
      for (const answer of Object.values(this.userState.recallAnswers || {})) if (answer.text) lines.push(`\n## ${answer.question}`, answer.text);
      for (const [key, note] of Object.entries(this.userState.notes || {})) if (note.text) lines.push(`\n## ${this.groupLabel(key)}`, note.text);
      for (const note of this.userState.unmappedNotes || []) lines.push(`\n## ${tr("待重新定位的笔记", "Note awaiting source alignment")}`, note.quote || note.originalKey, note.text);
      return lines.filter((s) => s !== undefined).join("\n\n");
    }

    async saveReadingNote() {
      const note = new Zotero.Item("note"), parent = this.parentItem;
      note.libraryID = this.item.libraryID;
      if (parent && parent.id !== this.item.id) note.parentID = parent.id;
      // User-authored text stays literal when saved, including HTML-like research notation.
      const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      note.setNote(`<div>${this.readingRecord().split("\n\n").map((s) => `<p>${escape(s).replace(/\n/g, "<br>")}</p>`).join("")}</div>`);
      await note.saveTx();
      return note;
    }

    get highlightDensity() {
      const d = this.userState.highlightDensity;
      return ["manual", "sparse", "standard", "detailed"].includes(d) ? d : "standard";
    }

    setHighlightDensity(value) {
      if (!["manual", "sparse", "standard", "detailed"].includes(value)) return;
      this.userState.highlightDensity = value;
      this._automaticHighlights = null;
      this._saveUserStateSoon();
      this.overlay.renderAllPages();
      this._emit("reading");
    }

    highlightLevel(point) {
      const manual = this.userState.pointImportance?.[point.id];
      if (manual !== undefined) return Number(manual);
      const data = this.data?.hierarchicalData;
      if (!this._automaticHighlights || this._highlightSelectionFor !== data) {
        this._highlightSelectionFor = data;
        this._automaticHighlights = DeepRead.Highlights.select(data, { density: this.highlightDensity,
          roleOf: (key) => this.paragraphRole(key), goal: this.userState.readingGoal?.kind });
      }
      return this._automaticHighlights.get(point.id) || 1;
    }

    _saveUserStateSoon() {
      clearTimeout(this._saveUserStateTimer);
      this._saveUserStateTimer = setTimeout(() => {
        DeepRead.Store.savePaper(this.key, this.item.id, { user_state: this.userState })
          .catch((e) => DeepRead.log("saving user state failed", String(e)));
      }, 500);
    }

    static paragraphKey(paragraph) {
      return `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`;
    }

    /** Paragraph summary with the user's inline edit applied. */
    paragraphSummary(paragraph) {
      const edit = this.userState.edits?.[DeepRead.Session.paragraphKey(paragraph)];
      return edit?.summary ?? paragraph.paragraphSummary ?? "";
    }

    setParagraphSummary(paragraph, summary) {
      const key = DeepRead.Session.paragraphKey(paragraph);
      const edits = { ...(this.userState.edits || {}) };
      if (!summary || summary === paragraph.paragraphSummary) delete edits[key];
      else edits[key] = { ...(edits[key] || {}), summary };
      this.userState.edits = edits;
      this._saveUserStateSoon();
    }

    isCardHidden(key) {
      return !!this.userState.hidden?.[key];
    }

    get hiddenCardCount() {
      return Object.keys(this.userState.hidden || {}).length;
    }

    setCardHidden(key, hidden) {
      const map = { ...(this.userState.hidden || {}) };
      if (hidden) map[key] = true;
      else delete map[key];
      this.userState.hidden = map;
      this._saveUserStateSoon();
      this.rail?.refresh();
    }

    showHiddenCards() {
      this.userState.hidden = {};
      this._saveUserStateSoon();
      this.rail?.refresh();
    }

    /* ---------- the reader's own understanding ---------- */

    paragraphNote(key) {
      return this.userState.notes?.[key]?.text || "";
    }

    setParagraphNote(key, text) {
      const notes = { ...(this.userState.notes || {}) };
      const value = String(text || "").trim();
      if (value) notes[key] = { text: value, updatedAt: new Date().toISOString() };
      else delete notes[key];
      this.userState.notes = notes;
      this._saveUserStateSoon();
      this.rail?.refresh();
      this._emit("notes", { key });
    }

    /** Paragraph (as "p_<page>_<index>") whose text best overlaps the given rects, or "". */
    paragraphKeyForRects(pageIndex, rects) {
      const page = (this.data?.hierarchicalData || []).find((p) => p.pageIndex === pageIndex);
      if (!page || !Array.isArray(rects) || !rects.length) return "";
      const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
      const inter = (a, b) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
      let best = "";
      let bestScore = 0;
      for (const paragraph of page.paragraphs || []) {
        let score = 0;
        for (const r of rects) for (const pr of paragraph.rects || []) score += inter(r, pr);
        if (score > bestScore) {
          bestScore = score;
          best = `p_${pageIndex}_${paragraph.paragraphIndex}`;
        }
      }
      return best;
    }

    /** [{ key, pageIndex, summary, note }] for every paragraph with a note, in reading order. */
    paragraphNotesList() {
      const out = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          const key = `p_${page.pageIndex}_${paragraph.paragraphIndex}`;
          const note = this.paragraphNote(key);
          if (note) out.push({ key, pageIndex: page.pageIndex, summary: this.paragraphSummary({ ...paragraph, pageIndex: page.pageIndex }), note });
        }
      }
      return out;
    }

    pointLevel(point) {
      const override = this.userState.pointImportance?.[point.id];
      if (override !== undefined) return Number(override);
      if (point.importance_source === "model" || point.importance_level > 1) return Number(point.importance_level || 1);
      const data = this.data?.hierarchicalData;
      if (this._highlightData !== data || this._highlightExplanations !== this.explanations || !this._suggestedHighlights) {
        this._highlightData = data;
        this._highlightExplanations = this.explanations;
        this._suggestedHighlights = DeepRead.Highlights?.defaults(data, (key) => this.paragraphRole(key)) || new Set();
      }
      return this._suggestedHighlights.has(point.id) ? 2 : 1;
    }

    /** Highlighter colours ("#rrggbb"): level 2 is the first colour, level 3 the second, … */
    highlightColors() {
      return DeepRead.prefs.highlightColors?.() || ["#3b82f6", "#ef4444"];
    }

    /** Colour of a point level, or "" for level 1 (not highlighted). Levels beyond the list use the last colour. */
    levelColor(level) {
      if (!(level >= 2)) return "";
      const colors = this.highlightColors();
      return colors[Math.min(level - 2, colors.length - 1)];
    }

    /** One click on a key point: next highlighter colour, and after the last one back to none. */
    nextPointLevel(point) {
      const level = this.pointLevel(point);
      return level >= this.highlightColors().length + 1 ? 1 : level + 1;
    }

    setPointImportance(pointId, level) {
      this.userState.pointImportance = { ...(this.userState.pointImportance || {}), [pointId]: level };
      this.overlay.renderAllPages();
      this.rail?.refresh();
      this._saveUserStateSoon();
    }

    /* ---------- navigation ---------- */

    _allParagraphs() {
      const out = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          out.push({ ...paragraph, pageIndex: page.pageIndex });
        }
      }
      return out;
    }

    findParagraphByMinerUid(uid) {
      if (uid === undefined || uid === null) return null;
      return this._allParagraphs().find((p) => String(p.minerUid) === String(uid)) || null;
    }

    _blockByID(blockId) {
      for (const section of this.data?.blockMapping || []) {
        for (const block of section.blocks || []) {
          if (String(block.block_id) === String(blockId)) return block;
        }
      }
      return null;
    }

    _titleBlock(titleBlockId) {
      return (this.data?.blockMapping || []).find((s) => String(s.title_block_id) === String(titleBlockId)) || null;
    }

    async navigateToParagraph(paragraph) {
      if (!paragraph) return false;
      const rects = paragraph.rects?.length ? paragraph.rects : null;
      const position = rects
        ? { pageIndex: paragraph.pageIndex, rects: [DeepRead.Overlay.unionRect(rects)] }
        : { pageIndex: paragraph.pageIndex ?? paragraph.page_idx ?? 0, rects: [[0, 0, 1, 1]] };
      await this.reader.navigate({ position });
      if (rects) this.overlay.flash(paragraph);
      return true;
    }

    /** Jump to a paragraph block ("p. 3 ¶2" in the chat) and open its card. */
    async openBlock(pageIndex, paragraphIndex) {
      const paragraph = (this.overlay.pages.get(pageIndex) || []).find((p) => p.paragraphIndex === paragraphIndex);
      if (!paragraph) return this.reader.navigate({ pageIndex });
      await this.navigateToParagraph(paragraph);
      this.overlay.openParagraph(paragraph);
      return true;
    }

    async navigateToBlockIds(blockIds) {
      for (const id of blockIds || []) {
        const block = this._blockByID(id);
        const paragraph = block && this.findParagraphByMinerUid(block.minerUid);
        if (paragraph) return this.navigateToParagraph(paragraph);
        if (block?.page_idx !== undefined) {
          await this.reader.navigate({ pageIndex: block.page_idx });
          return true;
        }
      }
      return false;
    }

    async navigateToTitleBlock(titleBlockId) {
      const title = this._titleBlock(titleBlockId);
      const paragraph = title && this.findParagraphByMinerUid(title.minerUid);
      if (paragraph) return this.navigateToParagraph(paragraph);
      if (title?.page_idx !== undefined) {
        await this.reader.navigate({ pageIndex: title.page_idx });
        return true;
      }
      return false;
    }

    /* ---------- AI chat bridge ---------- */

    askAI({ text, pageIndex, block }) {
      const quote = String(text || "").trim();
      if (quote) this.pendingQuotes.push({ text: quote.slice(0, 8000), pageIndex, block });
      this._emit("ask");
      DeepRead.Panes.reveal(this.reader, "chat");
    }

    /**
     * Strip bulky per-character mappings before persisting; overlays only need rects.
     */
    static compactHierarchicalData(hierarchicalData) {
      return (hierarchicalData || []).map((page) => ({
        pageIndex: page.pageIndex,
        paragraphs: (page.paragraphs || []).map((p) => ({
          paragraphIndex: p.paragraphIndex,
          paragraphType: p.paragraphType,
          paragraphText: p.paragraphText,
          typography: p.typography,
          continuation: p.continuation,
          continuationChecked: p.continuationChecked === true,
          paragraphSummary: p.paragraphSummary,
          minerUid: p.minerUid,
          importance_level: p.importance_level,
          bbox: p.bbox,
          rects: p.rects,
          sentences: (p.sentences || []).map((s) => ({ id: s.id, sentenceIndex: s.sentenceIndex, text: s.text, rects: s.rects })),
          points: (p.points || []).map((pt) => ({
            id: pt.id,
            pointIndex: pt.pointIndex,
            sentenceIndices: pt.sentenceIndices,
            summary: pt.summary,
            translation: pt.translation,
            rects: pt.rects,
            importance_level: pt.importance_level,
            importance_source: pt.importance_source,
          })),
        })),
      }));
    }
  };
})();

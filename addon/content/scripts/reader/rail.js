/*
 * Margin rail: persistent paragraph summary cards beside the PDF.
 *
 * The PDF iframe shares the reader width with adjacent card rails in the reader document.
 * Each card is anchored at the vertical position of its paragraph,
 * pushed down to avoid overlaps (with a connector back to the anchor), and kept in sync with
 * scrolling and zooming.
 *
 * License: AGPL-3.0-or-later. Card design follows Vibero (AGPL-3.0, a Zotero fork).
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GAP = 10;
  const OVERSCAN = 400;



  /** Which 带读 step a card note belongs to. */
  function note0Step(note) {
    return { component: 3, hedge: 4, claim: 4, move: 2 }[note?.kind] || 1;
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.Rail = class Rail {
    constructor(session) {
      this.session = session;
      this.cards = new Map(); // key → { el, height, width, anchor, kind, data, sig }
      this.expanded = new Set();
      this.focusKey = null; // card opened by clicking its paragraph in the PDF
      this.drafts = new Map(); // unsaved editor text, kept when a card re-renders (e.g. it is closed)
      this.trToggled = new Set(); // cards whose translation fold differs from the default (pref cards.translationOpen)
      this.attached = false;
      this._cleanup = [];
      this._raf = null;
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "cards");
    }

    /** "split": left-column paragraphs get cards on the left of the PDF; "right": one rail. */
    get layoutMode() {
      return DeepRead.prefs.get("view.railLayout") === "right" ? "right" : "split";
    }

    /** Which rail a paragraph belongs to, from its horizontal position on the page. */
    _sideFor(pageIndex, rect) {
      if (this.layoutMode !== "split" || !rect) return "right";
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return "right";
      const pct = this.overlay._toPercent(geom, rect);
      if (pct.width > 60) return "right"; // full-width (single-column) block
      if (!this._isTwoColumn(pageIndex, geom)) return "right"; // e.g. a short heading on a one-column page
      return pct.left + pct.width / 2 < 50 ? "left" : "right";
    }

    _isTwoColumn(pageIndex) {
      return this.overlay.isTwoColumn(pageIndex);
    }

    /** Expanded by the reader (summary click) or opened by clicking the paragraph. */
    isOpen(key) {
      key = this.session.groupLead(key);
      if (this.isCollapsed(key)) return false;
      return (!this.session.focusReading && [...this.expanded].some((k) => this.session.groupLead(k) === key))
        || !!(this.focusKey && this.session.groupLead(this.focusKey) === key);
    }

    isCollapsed(key) {
      return [...(this.collapsed || [])].some((k) => this.session.groupLead(k) === key);
    }

    closeParagraph(key) {
      this.collapsed = this.collapsed || new Set();
      this.collapsed.add(key);
      for (const k of this.expanded) if (this.session.groupLead(k) === key) this.expanded.delete(k);
      if (this.focusKey && this.session.groupLead(this.focusKey) === key) this.focusKey = null;
      this._revealPending = false;
      this._invalidate(key);
      this.schedule(true);
    }

    /**
     * Open a paragraph's card (full card, next to its paragraph, scrolled into view); null closes it.
     * With "keep cards open" (pref cards.keepOpen) the previously opened card stays expanded.
     */
    openParagraph(paragraph, { toggle = false } = {}) {
      const raw = paragraph ? `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}` : null;
      const key = raw ? this.session.groupLead(raw) : null;
      if (toggle && key && this.isOpen(key)) {
        this.closeParagraph(key);
        return;
      }
      if (key) for (const k of this.collapsed || []) if (this.session.groupLead(k) === key) this.collapsed.delete(k);
      this.focusParagraphKey = raw;
      if (key === this.focusKey) {
        if (key) this._revealPending = true;
        this.schedule();
        return;
      }
      const previous = this.focusKey;
      if (previous && !this.session.focusReading && DeepRead.prefs.get("cards.keepOpen") !== false) this.expanded.add(previous);
      this.focusKey = key;
      if (key && raw !== key) paragraph = this.session._paragraphByKey(key)?.paragraph || paragraph;
      if (key && this.session.isCardHidden?.(key)) this.session.setCardHidden(key, false);
      if (previous) this._invalidate(previous);
      if (key) {
        this._revealPending = true;
        this._invalidate(key);
        // An opened card should have its explanation: generate it now if it is missing.
        if (DeepRead.prefs.get("cards.autoExplain") !== false && paragraph && !this.session.explanation(key)
            && DeepRead.Explainer?.eligible(paragraph) && DeepRead.LLM.isConfigured()) {
          this.session.explainParagraph(key).catch((e) => DeepRead.log("explain on open failed", String(e)));
        }
      }
    }

    /** Fold every expanded card. */
    collapseAll() {
      const keys = [...this.expanded, this.focusKey].filter(Boolean);
      this.collapsed = this.collapsed || new Set();
      for (const key of keys) this.collapsed.add(this.session.groupLead(key));
      this.expanded.clear();
      this.focusKey = null;
      for (const key of keys) this._invalidate(key);
      this.schedule(true);
    }

    get openCount() {
      return new Set([...this.expanded, this.focusKey].filter(Boolean)).size;
    }

    /** "p. 3 ¶2" — how cards are referred to in the chat. */
    /** First figure/table mentioned in a paragraph: { id, panel } or null. */
    static figureMention(text, figures) {
      if (!text || !figures?.length) return null;
      const re = /(?<![A-Za-z])(Figs?|Figures?|Tables?|Tab)\.?\s*(\d+|[IVX]+)(?:\s*\(([a-z])\)|([a-z])(?![A-Za-z]))?/gi;
      for (const m of text.matchAll(re)) {
        const kind = /^t/i.test(m[1]) ? "table" : "figure";
        const figure = figures.find((f) => f.kind === kind && String(f.number).toUpperCase() === m[2].toUpperCase());
        if (figure) return { id: figure.id, panel: (m[3] || m[4] || "").toLowerCase() || null };
      }
      return null;
    }

    /** "图 3" / "Fig. 3", "表 I" / "Table I" in the interface language. */
    static figureLabel(figure) {
      const table = figure.kind === "table";
      return DeepRead.bilingual(`${table ? "表" : "图"} ${figure.number}`, `${table ? "Table" : "Fig."} ${figure.number}`);
    }

    static roleLabel(role) {
      const labels = {
        background: ["背景", "Background"], gap: ["空白", "Gap"], prior: ["已有方案", "Prior work"],
        contribution: ["贡献", "Contribution"], method: ["方法", "Method"], result: ["结果", "Result"], limitation: ["局限", "Limitation"],
      };
      const [zh, en] = labels[role] || [role, role];
      return DeepRead.bilingual(zh, en);
    }

    static blockLabel(paragraph) {
      return `p. ${paragraph.pageIndex + 1} ¶${paragraph.paragraphIndex + 1}`;
    }

    /** After layout: scroll the PDF so the opened card is fully visible (its paragraph stays on screen). */
    _revealFocus(railHeight) {
      this._revealPending = false;
      const card = this.cards.get(this.focusKey);
      if (!card || card.el.hidden) return;
      const top = card.el.offsetTop;
      const bottom = top + card.el.offsetHeight;
      let delta = 0;
      if (bottom > railHeight - 8) delta = Math.min(bottom - (railHeight - 8), top - 8);
      else if (top < 8) delta = top - 8;
      if (Math.abs(delta) < 2) return;
      const container = this.app?.pdfViewer?.container;
      if (container) container.scrollTop += delta;
    }

    _hasLeftItems() {
      if (this.layoutMode !== "split") return false;
      for (const [pageIndex, paragraphs] of this.overlay.pages) {
        for (const paragraph of paragraphs) {
          if (this._sideFor(pageIndex, paragraph.bbox) === "left") return true;
        }
      }
      return false;
    }

    get overlay() {
      return this.session.overlay;
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.pdfWin = view._iframeWindow;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      this.container = view._iframe?.parentElement;
      if (!this.container) return;
      this.attached = true;
      this.refresh();
    }

    detach() {
      this._teardownDOM();
      this.attached = false;
    }

    _teardownDOM() {
      DeepRead.UI?.closeMenu(this.readerDoc);
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      if (this._raf && this.readerWin) this.readerWin.cancelAnimationFrame(this._raf);
      this._raf = null;
      this.root?.remove();
      this.root = null;
      this.leftRoot?.remove();
      this.leftRoot = null;
      this.cards.clear();
      this.container?.classList.remove("deepread-has-rail");
      this.overlay.setRailActive?.(false);
    }

    /** Should the rail be shown right now? */
    _wanted() {
      if (!this.attached || !this.enabled) return false;
      return this.overlay.pages.size > 0;
    }

    /** Re-evaluate visibility and contents (call after data or settings change). */
    refresh() {
      if (!this.attached) return;
      if (!this._wanted()) {
        if (this.root) this._teardownDOM();
        return;
      }
      // Rebuild when the rail layout changed (e.g. a left rail is now needed or no longer needed).
      const wantLeft = this._hasLeftItems();
      if (this.root && !!this.leftRoot !== wantLeft) this._teardownDOM();
      if (!this.root) this._buildDOM(wantLeft);
      for (const card of this.cards.values()) card.sig = null; // force content refresh
      this.schedule(true);
    }

    _buildDOM(withLeft = false) {
      const doc = this.readerDoc;
      DeepRead.UI?.install(doc);
      DeepRead.util.injectStylesheet(doc, "chrome://deepread/content/styles/rail.css", "deepread-rail-css");
      if (!doc.getElementById("deepread-katex-css")) {
        const link = doc.createElementNS(HTML_NS, "link");
        link.id = "deepread-katex-css";
        link.rel = "stylesheet";
        link.href = "chrome://deepread/content/lib/katex/katex.min.css";
        (doc.head || doc.documentElement).append(link);
        this._cleanup.push(() => link.remove());
      }
      const makeRail = (cls, side) => {
        const rail = el(doc, "div", cls);
        const svg = doc.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "dr-links");
        const fold = el(doc, "button", "dr-collapse");
        fold.addEventListener("click", (e) => {
          e.stopPropagation();
          DeepRead.prefs.set(DeepRead.Rail.collapsePref(side), !this._collapsed(side));
        });
        // The folded strip is one big button.
        rail.addEventListener("click", () => {
          if (this._collapsed(side)) DeepRead.prefs.set(DeepRead.Rail.collapsePref(side), false);
        });
        rail.append(svg, this._resizeHandle(side), fold);
        rail._svg = svg;
        rail._fold = fold;
        rail._side = side;
        return rail;
      };
      this.root = makeRail("deepread-rail dr-right", "right");
      this.svg = this.root._svg;
      this.container.classList.add("deepread-has-rail");
      this.container.append(this.root);
      if (withLeft) {
        this.leftRoot = makeRail("deepread-rail dr-left", "left");
        this.container.prepend(this.leftRoot);
      }
      this._applySizing();
      this._applyCollapsed();
      // Card width / font size / translation fold follow the settings live.
      const observers = ["view.railWidth", "view.cardFontSize", "cards.translationOpen"].map((name) =>
        Zotero.Prefs.registerObserver(`deepread.${name}`, () => {
          this._applySizing();
          for (const card of this.cards.values()) card.sig = null;
          this.schedule(true);
        }));
      // Layout (split / right only) needs a rebuild, which unregisters this observer: do it after the callback.
      observers.push(Zotero.Prefs.registerObserver("deepread.view.railLayout", () => this.readerWin?.setTimeout(() => this.refresh(), 0)));
      for (const name of ["view.railCollapsedLeft", "view.railCollapsedRight"]) {
        observers.push(Zotero.Prefs.registerObserver(`deepread.${name}`, () => {
          this._applyCollapsed();
          this.schedule(true);
        }));
      }
      this._cleanup.push(() => observers.forEach((id) => Zotero.Prefs.unregisterObserver(id)));
      this.overlay.setRailActive?.(true);

      const schedule = () => this.schedule();
      const viewer = this.pdfWin.document.getElementById("viewerContainer");
      viewer?.addEventListener("scroll", schedule, { passive: true });
      this._cleanup.push(() => viewer?.removeEventListener("scroll", schedule));
      const onRendered = Components.utils.exportFunction((event) => {
        // Figure thumbnails are cut from the page canvas: redraw them once their page has rendered.
        const page = Number(event?.pageNumber) - 1;
        for (const [key, card] of this.cards) if (key.startsWith("g_") && card.page === page) card.sig = null;
        this.schedule(true);
      }, this.pdfWin);
      try {
        this.app.eventBus.on("pagerendered", onRendered);
        this.app.eventBus.on("scalechanging", onRendered);
        this.app.eventBus.on("rotationchanging", onRendered);
      }
      catch (e) {}
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagerendered", onRendered);
          this.app.eventBus.off("scalechanging", onRendered);
          this.app.eventBus.off("rotationchanging", onRendered);
        }
        catch (e) {}
      });
      const ro = new this.readerWin.ResizeObserver(() => this.schedule(true));
      ro.observe(this.root);
      if (this.leftRoot) ro.observe(this.leftRoot);
      this._cleanup.push(() => ro.disconnect());
      this._cleanup.push(() => this.readerDoc.getElementById("deepread-rail-css")?.remove());
    }

    static collapsePref(side) {
      return side === "left" ? "view.railCollapsedLeft" : "view.railCollapsedRight";
    }

    _collapsed(side) {
      return DeepRead.prefs.get(DeepRead.Rail.collapsePref(side)) === true;
    }

    _applyCollapsed() {
      for (const rail of [this.root, this.leftRoot]) {
        if (!rail) continue;
        const folded = this._collapsed(rail._side);
        rail.classList.toggle("dr-collapsed", folded);
        const away = rail._side === "left" ? "‹" : "›";
        const back = rail._side === "left" ? "›" : "‹";
        rail._fold.textContent = folded ? `${back} ${DeepRead.bilingual("卡片", "Cards")}` : away;
        rail._fold.title = folded ? DeepRead.bilingual("展开卡片栏", "Show the cards")
          : DeepRead.bilingual("收起卡片栏（给 AI 对话等腾出空间）", "Fold the cards away (e.g. to make room for the AI chat)");
      }
    }

    static clampWidth(value) {
      return Math.max(200, Math.min(520, Math.round(Number(value) || 280)));
    }

    static clampFont(value) {
      return Math.max(10, Math.min(18, Math.round(Number(value) || 12)));
    }

    _applySizing(width = DeepRead.Rail.clampWidth(DeepRead.prefs.number("view.railWidth", 280))) {
      const font = DeepRead.Rail.clampFont(DeepRead.prefs.number("view.cardFontSize", 12));
      for (const rail of [this.root, this.leftRoot]) {
        rail?.style.setProperty("--dr-rail-width", `${width}px`);
        rail?.style.setProperty("--dr-card-font", `${font}px`);
      }
    }

    /** Drag the rail's edge facing the PDF to resize the cards (saved as view.railWidth). */
    _resizeHandle(side) {
      const handle = el(this.readerDoc, "div", "dr-resize");
      handle.title = DeepRead.bilingual("拖动调整卡片宽度", "Drag to resize the cards");
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = handle.parentNode.clientWidth;
        const dir = side === "left" ? 1 : -1;
        let width = startWidth;
        handle.classList.add("dr-dragging");
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          width = DeepRead.Rail.clampWidth(startWidth + dir * (ev.clientX - startX));
          this._applySizing(width);
          this.schedule(true);
        };
        const up = () => {
          handle.classList.remove("dr-dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          if (width !== startWidth) DeepRead.prefs.set("view.railWidth", width);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      return handle;
    }

    /** Translation fold of a card: default from the settings, flipped per card by the reader. */
    _translationOpen(key) {
      const byDefault = DeepRead.prefs.get("cards.translationOpen") === true;
      return this.trToggled.has(key) ? !byDefault : byDefault;
    }

    schedule(remeasure = false) {
      if (remeasure) this._remeasure = true;
      if (!this.root || this._raf) return;
      this._raf = this.readerWin.requestAnimationFrame(() => {
        this._raf = null;
        try {
          this._layout();
        }
        catch (e) {
          DeepRead.log("rail layout failed", e?.stack || String(e));
        }
      });
    }

    /* ---------- items ---------- */

    _items() {
      const items = [];
      const all = new Map([...this.overlay.pages].flatMap(([page, paras]) => paras.map((p) => [`p_${page}_${p.paragraphIndex}`, p])));
      for (const [pageIndex, paragraphs] of this.overlay.pages) {
        for (const paragraph of paragraphs) {
          const key = `p_${pageIndex}_${paragraph.paragraphIndex}`;
          // Paragraphs merged into one card are drawn inside their first paragraph's card.
          if (this.session.groupLead(key) !== key || this.session.isCardHidden?.(key)) continue;
          const keys = this.session.groupMembers(key).filter((k) => all.has(k));
          const members = keys.length > 1 ? keys.map((k) => all.get(k)) : null;

          const anchor = this.focusKey === key && keys.includes(this.focusParagraphKey) ? all.get(this.focusParagraphKey) : paragraph;
          items.push({ key, kind: "paragraph", pageIndex: anchor.pageIndex, rect: anchor.bbox, data: paragraph, members });
        }
      }
      if (DeepRead.Modules.enabled(this.session, "figureCards") && this.session.hasResults) {
        const figures = this.session.figures();
        for (const figure of figures) {
          const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
          if (rect) items.push({ key: `g_${figure.id}`, kind: "figure", pageIndex: figure.pageIndex, rect, data: figure });
        }
        // Papers read before figure guides existed: write them once, in the background.
        if (figures.length && !this.session._figuresRequested && DeepRead.prefs.get("cards.autoExplain") !== false) {
          this.session._figuresRequested = true;
          this.session.explainFigures().catch((e) => DeepRead.log("figure guides failed", String(e)));
        }
      }
      return items;
    }

    /** Anchor y (rail coordinates) of a PDF rect's top edge, or null if the page is not laid out. */
    _anchorY(pageIndex, rect) {
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return null;
      const pct = this.overlay._toPercent(geom, rect);
      const box = geom.div.getBoundingClientRect();
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      return frame.top - rail.top + box.top + geom.div.clientTop + (pct.top / 100) * geom.div.clientHeight;
    }

    _visiblePages(railHeight) {
      const visible = new Set();
      const count = this.app?.pdfViewer?.pagesCount || 0;
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      const offset = frame.top - rail.top;
      for (let i = 0; i < count; i++) {
        const div = this.app.pdfViewer.getPageView(i)?.div;
        if (!div) continue;
        const r = div.getBoundingClientRect();
        if (r.bottom + offset > -OVERSCAN && r.top + offset < railHeight + OVERSCAN) visible.add(i);
      }
      return visible;
    }

    /** Top/bottom (rail coordinates) of a page box. */
    _pageRange(pageIndex) {
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return null;
      const box = geom.div.getBoundingClientRect();
      const offset = this.view._iframe.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
      return { top: offset + box.top, bottom: offset + box.bottom };
    }

    _layout() {
      if (!this.root) return;
      const railHeight = this.root.clientHeight;
      for (const rail of [this.root, this.leftRoot]) rail?.style.setProperty("--dr-card-max-height", `${Math.max(80, railHeight - 16)}px`);
      const visible = this._visiblePages(railHeight);
      const items = this._items().filter((item) => visible.has(item.pageIndex));
      for (const item of items) item.anchor = this._anchorY(item.pageIndex, item.rect);
      const placed = items.filter((item) => item.anchor !== null).sort((a, b) => a.anchor - b.anchor);
      // Zoom/resize: re-decide which pages need compact cards.
      if (this._remeasure) this.compactPages = new Set();
      this.compactPages = this.compactPages || new Set();

      const width = this.root.clientWidth;
      const keep = new Set();
      const links = { left: [], right: [] };
      this._sideOfKey = new Map();
      for (const item of placed) {
        item.side = this.leftRoot ? this._sideFor(item.pageIndex, item.rect) : "right";
        this._sideOfKey.set(item.key, item.side);
      }
      // Pages laid out after the rail was built may reveal left-column paragraphs.
      if (!this.leftRoot && this.layoutMode === "split" && !this._leftCheckPending
          && placed.some((item) => this._sideFor(item.pageIndex, item.rect) === "left")) {
        this._leftCheckPending = true;
        setTimeout(() => {
          this._leftCheckPending = false;
          this.refresh();
        }, 0);
      }
      // Lay out each rail page by page so that a crowded page never pushes the next page's
      // cards away from their paragraphs: if a page's cards overflow its box, they switch to
      // compact mode (summary line only, open explicitly). The reader's own notes stay visible.
      for (const side of ["left", "right"]) {
        if (this._collapsed(side) && (side === "right" || this.leftRoot)) continue;
        const sideItems = placed.filter((item) => item.side === side);
        const pages = [];
        for (const item of sideItems) {
          let group = pages[pages.length - 1];
          if (!group || group.pageIndex !== item.pageIndex) pages.push(group = { pageIndex: item.pageIndex, items: [] });
          group.items.push(item);
        }
        let bottom = -Infinity;
        for (const group of pages) {
          const range = this._pageRange(group.pageIndex);
          const compactKey = `${side}:${group.pageIndex}`;
          const stack = () => {
            const heights = group.items.map((item) => this._ensureCard(item, width).height);
            const open = group.items.findIndex((item) => item.key === this.focusKey);
            let b = bottom;
            if (open < 0) {
              group.items.forEach((item, i) => {
                item.top = Math.max(item.anchor, b + GAP);
                b = item.top + heights[i];
              });
              return b;
            }
            // Keep the opened card beside its paragraph: cards above it stack upwards from it,
            // cards below it downwards; shift down only if the stack would hit the previous page.
            const items = group.items;
            items[open].top = Math.max(items[open].anchor, bottom + GAP);
            for (let i = open - 1; i >= 0; i--) items[i].top = Math.min(items[i].anchor, items[i + 1].top - GAP - heights[i]);
            const shift = Math.max(0, bottom + GAP - items[0].top);
            for (let i = 0; i <= open; i++) items[i].top += shift;
            b = items[open].top + heights[open];
            for (let i = open + 1; i < items.length; i++) {
              items[i].top = Math.max(items[i].anchor, b + GAP);
              b = items[i].top + heights[i];
            }
            return b;
          };
          let end = stack();
          if (range && end > range.bottom + 8 && !this.compactPages.has(compactKey)) {
            this.compactPages.add(compactKey);
            end = stack();
          }
          bottom = end;
          for (const item of group.items) {
            const card = this.cards.get(item.key);
            keep.add(item.key);
            const onScreen = item.top + card.height > -50 && item.top < railHeight + 50;
            card.el.hidden = !onScreen;
            if (onScreen) {
              card.el.style.top = `${Math.round(item.top)}px`;
              links[side].push({ anchor: item.anchor, top: item.top, kind: item.kind });
            }
          }
        }
      }
      for (const [key, card] of this.cards) {
        if (!keep.has(key)) {
          DeepRead.UI?.closeMenu(this.readerDoc, card.el);
          card.el.remove();
          this.cards.delete(key);
        }
      }
      this._remeasure = false;
      if (this._revealPending) this._revealFocus(railHeight);
      this._drawLinks(this.svg, links.right, "right");
      if (this.leftRoot) this._drawLinks(this.leftRoot._svg, links.left, "left");
    }

    _drawLinks(svg, links, side) {
      while (svg.firstChild) svg.firstChild.remove();
      const w = svg.parentNode?.clientWidth || 0;
      // The connector gutter faces the page: left edge of the right rail, right edge of the left rail.
      const x = side === "left" ? w - 3 : 3;
      const x2 = side === "left" ? w - 12 : 12;
      for (const { anchor, top, kind } of links) {
        const color = kind === "figure" ? "rgba(217,119,6,0.7)" : "rgba(107,114,128,0.55)";
        const dot = this.readerDoc.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(anchor + 4));
        dot.setAttribute("r", "2");
        dot.setAttribute("fill", color);
        svg.append(dot);
        if (Math.abs(top - anchor) > 3) {
          const path = this.readerDoc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", `M${x} ${anchor + 4} L${x} ${top + 10} L${x2} ${top + 10}`);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", "1");
          svg.append(path);
        }
      }
    }

    /* ---------- cards ---------- */

    _signature(item) {
      if (item.kind === "figure") {
        const focus = this.figureFocus?.id === item.data.id ? this.figureFocus.panel || "*" : "";
        return `g|${JSON.stringify(this.session.figureGuide(item.data.id))}|${this.session.explainingFigures}|${focus}`
          + `|${this.figureExpanded?.has(item.data.id)}|${this.figureCollapsed?.has(item.data.id)}|${this.session.focusReading}`
          + `|${JSON.stringify(this.session.figureNote(item.data.id))}|${this.figureEditing === item.data.id}`
          + `|${this.figureGuideOpen?.has(item.data.id)}`
          + `|${this.compactPages?.has(`${item.side || "right"}:${item.pageIndex}`) ? "c" : ""}`;
      }
      const paras = item.members || [item.data];
      const keys = paras.map((p) => `p_${p.pageIndex}_${p.paragraphIndex}`);
      const levels = paras.flatMap((p) => p.points || []).map((pt) => this.session.pointLevel(pt)).join("");
      const skim = this.session.skimDepth === "full" ? "" : `${this.session.skimDepth}:${this.session.skimTiers().tier.get(item.key) || ""}`;
      const questions = (this.session.questionsForKey?.(item.key) || []).map((q) => q.id).join(",");
      const guided = this.session.guide && DeepRead.Modules.enabled(this.session, "guided") ? this.session.guide.meta?.finishedAt || 1 : "";
      return `p|${keys.join(",")}|${this.session.groupTitle(item.key)}|${this.session.highlightColors().join("")}|${skim}|${questions}|${guided}`
        + `|${this.session.focusReading}`
        + `|${keys.map((k) => this.session.needsReview(k)).join(",")}`
        + `|${this.isCollapsed(item.key)}`
        + `|${this.overlay.translationsFor(paras).join("\u001f")}`
        + `|${paras.map((p) => this.session.paragraphSummary(p)).join("|")}|${levels}|${this.isOpen(item.key)}|${this.focusKey === item.key}|${this._translationOpen(item.key)}`
        + `|${this.session.explanation(item.key)}|${this.session.isExplaining(item.key)}|${this.session.paragraphRole?.(item.key)}`
        + `|${this.compactPages?.has(`${item.side || "right"}:${item.pageIndex}`) ? "c" : ""}`
        + `|${keys.map((k) => this.session.paragraphNote(k)).join("|")}|${this.noteEditing === item.key}|`;
    }

    _invalidate(key) {
      const card = this.cards.get(key);
      if (card) card.sig = null;
      this.schedule(true);
    }

    _ensureCard(item, width) {
      let card = this.cards.get(item.key);
      const sig = this._signature(item);
      if (!card) {
        card = { el: el(this.readerDoc, "div", "dr-rcard"), height: 0, width: 0, sig: null, page: item.pageIndex };
        card.el.dataset.key = item.key;
        this.cards.set(item.key, card);
      }
      const parent = item.side === "left" && this.leftRoot ? this.leftRoot : this.root;
      if (card.el.parentNode !== parent) {
        parent.append(card.el);
        card.height = 0;
      }
      const editingFigure = item.kind === "figure" && this.figureEditing === item.data.id
        && card.el.contains(this.readerDoc.activeElement) && this.readerDoc.activeElement?.localName === "textarea";
      const active = this.readerDoc.activeElement;
      const editingParagraph = item.kind === "paragraph" && card.el.contains(active)
        && (active?.isContentEditable || (this.noteEditing === item.key && active?.localName === "textarea"));
      if (card.sig !== sig && !editingFigure && !editingParagraph) {
        DeepRead.UI?.closeMenu(this.readerDoc, card.el, true);
        const focus = this.readerDoc.activeElement;
        const focusedAction = card.el.contains(focus) ? focus?.getAttribute("data-dr-action") : null;
        const scrollTop = card.el.scrollTop;
        card.el.replaceChildren();
        if (item.kind === "figure") this._fillFigure(card.el, item.data, item);
        else this._fillParagraph(card.el, item.key, item.data, item.members);
        card.sig = sig;
        card.height = 0;
        card.el.scrollTop = scrollTop;
        if (focusedAction) {
          const control = [...card.el.querySelectorAll("[data-dr-action]")]
            .find((candidate) => candidate.getAttribute("data-dr-action") === focusedAction);
          (control?.getClientRects().length ? control : card.el.querySelector(".dr-rsummary"))?.focus({ preventScroll: true });
        }
      }
      if (!card.height || card.width !== width || this._remeasure) {
        card.el.hidden = false;
        card.height = card.el.offsetHeight;
        card.width = width;
      }
      return card;
    }

    _button(container, label, title, onClick) {
      const b = el(this.readerDoc, "button", "", label);
      b.title = title;
      b.setAttribute("aria-label", title || label);
      b.setAttribute("data-dr-action", title || label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(e);
      });
      container.append(b);
      return b;
    }

    /** A paragraph card; `members` (≥ 2 paragraphs, first = `paragraph`) when one card covers several paragraphs. */
    _fillParagraph(node, key, paragraph, members = null) {
      const doc = this.readerDoc;
      const session = this.session;
      const paras = members || [paragraph];
      const keys = paras.map((p) => `p_${p.pageIndex}_${p.paragraphIndex}`);
      node.classList.toggle("dr-group", !!members);
      node.classList.toggle("dr-expanded", this.isOpen(key));
      node.classList.toggle("dr-open", this.focusKey === key);
      const side = this._sideOfKey?.get(key) || "right";
      // Skim layers fold minor cards (every card in "margin only") to their one-line summary.
      const depth = session.skimDepth;
      const skimFold = depth === "margin" || (depth === "key" && session.skimTiers().tier.get(key) === "minor");
      const focusFold = session.focusReading && !this.isOpen(key) && this.noteEditing !== key;
      const compact = (focusFold || this.isCollapsed(key) || skimFold || !!this.compactPages?.has(`${side}:${paragraph.pageIndex}`)) && !this.isOpen(key) && this.noteEditing !== key;
      node.classList.toggle("dr-focus-fold", !!focusFold);
      node.classList.toggle("dr-user-collapsed", this.isCollapsed(key));
      node.classList.toggle("dr-compact", compact);
      node.classList.add("dr-para");
      const role = session.paragraphRole?.(key) || "";
      node.dataset.role = role;
      const head = el(doc, "div", "dr-rhead");
      if (role) head.append(el(doc, "span", `dr-role dr-role-${role}`, DeepRead.Rail.roleLabel(role)));
      const level = Math.max(1, ...paras.flatMap((p) => p.points || []).map((p) => session.pointLevel(p)));
      if (level >= 2) {
        const dot = el(doc, "span", "dr-imp");
        dot.style.background = session.levelColor(level);
        dot.title = DeepRead.bilingual("含荧光笔标记的要点", "Has highlighted key points");
        head.append(dot);
      }
      const title = members ? session.groupTitle(key) || session.paragraphSummary(paragraph) : session.paragraphSummary(paragraph);
      const summary = el(doc, "div", "dr-rsummary", title || "…");
      summary.tabIndex = 0;
      summary.setAttribute("role", "button");
      summary.setAttribute("data-dr-action", "summary");
      summary.setAttribute("aria-expanded", String(!compact));
      summary.title = `${title || ""}\n${DeepRead.bilingual("单击或按 Enter 展开 / 收起", "Click or press Enter to open / close")}`;
      const toggleCard = () => {
        if (summary.isContentEditable) return;
        if (!node.classList.contains("dr-compact")) {
          this.closeParagraph(key);
        }
        else this.openParagraph(paragraph);
        this.schedule();
        if (this.cards.has(key)) this.cards.get(key).sig = null;
      };
      summary.addEventListener("click", toggleCard);
      const editSummary = () => {
        if (members) return; // a merged card's title is the AI's, not a paragraph summary
        summary.contentEditable = "true";
        summary.setAttribute("role", "textbox");
        summary.removeAttribute("aria-expanded");
        summary.setAttribute("aria-label", DeepRead.bilingual("编辑摘要", "Edit summary"));
        summary.focus();
        const range = doc.createRange();
        range.selectNodeContents(summary);
        doc.defaultView.getSelection().removeAllRanges();
        doc.defaultView.getSelection().addRange(range);
      };
      const finish = (save) => {
        if (summary.contentEditable !== "true") return;
        summary.contentEditable = "false";
        summary.setAttribute("role", "button");
        summary.setAttribute("aria-expanded", String(!node.classList.contains("dr-compact")));
        summary.removeAttribute("aria-label");
        if (save) session.setParagraphSummary(paragraph, summary.textContent.trim());
        else summary.textContent = session.paragraphSummary(paragraph);
        this.cards.get(key) && (this.cards.get(key).sig = null);
        this.schedule(true);
      };
      summary.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (!summary.isContentEditable) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCard(); }
          else if (e.key === "F2") { e.preventDefault(); editSummary(); }
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      summary.addEventListener("blur", () => finish(true));
      head.append(summary);
      // Reading questions this card helps answer.
      for (const q of session.questionsForKey?.(key) || []) {
        const pill = el(doc, "button", "dr-q", session.questionLabel(q));
        pill.title = q.question;
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          DeepRead.Panes?.reveal(session.reader, "questions");
        });
        head.append(pill);
      }
      if (members) {
        const range = el(doc, "span", "dr-range", DeepRead.bilingual(`${paras.length} 段`, `${paras.length} ¶`));
        range.title = session.groupLabel(key);
        head.append(range);
      }
      // One-line (compact) cards keep a hint of what is folded inside.

      const badges = el(doc, "span", "dr-badges");

      if (keys.some((k) => session.paragraphNote(k))) badges.append(el(doc, "span", "dr-badge dr-badge-note", DeepRead.bilingual("理解", "Note")));
      const reviewCount = keys.filter((k) => session.needsReview(k)).length;
      if (reviewCount) this._button(badges, DeepRead.bilingual(`待弄懂 ${reviewCount}`, `Revisit ${reviewCount}`),
        DeepRead.bilingual("查看待弄懂的段落", "Review flagged paragraphs"), () => DeepRead.Panes?.reveal(session.reader, "questions")).classList.add("dr-badge", "dr-badge-review");
      if (badges.childNodes.length) head.append(badges);

      const actions = el(doc, "div", "dr-ractions");
      const translations = this.overlay.translationsFor(paras);
      this._button(actions, DeepRead.bilingual("笔记", "Note"), DeepRead.bilingual("写我的理解", "Add my understanding"), () => {
        this.openParagraph(paragraph);
        this.noteEditing = key;
        this._invalidate(key);
      }).setAttribute("data-dr-action", "note");
      const eligible = paras.some((p) => DeepRead.Explainer?.eligible(p));
      this._button(actions, DeepRead.bilingual("提问", "Ask AI"), DeepRead.t("card.askAI"), () => {
        session.askAI({ text: paras.map((p) => p.paragraphText || "").filter(Boolean).join("\n\n"), pageIndex: paragraph.pageIndex, block: session.groupLabel(key) });
      }).setAttribute("data-dr-action", "ask");
      const focusSummary = (targetKey) => this.readerWin.requestAnimationFrame(() => {
        this.cards.get(this.session.groupLead(targetKey))?.el.querySelector(".dr-rsummary")?.focus({ preventScroll: true });
      });
      const more = this._button(actions, DeepRead.bilingual("更多 ···", "More ···"), DeepRead.bilingual("卡片操作", "Card actions"), () => {
        DeepRead.UI.openMenu(more, [
          !members && { id: "edit", label: DeepRead.bilingual("编辑摘要", "Edit summary"), restoreFocus: false, action: editSummary },
          { id: "copy-summary", label: DeepRead.t("card.copySummary"), action: () => {
            const lines = paras.flatMap((p) => [session.paragraphSummary(p), ...(p.points || []).map((pt) => `- ${pt.summary}`)]);
            DeepRead.util.copyToClipboard(lines.filter(Boolean).join("\n"));
          } },
          translations.length && { id: "copy-translation", label: DeepRead.t("card.copyTranslation"), action: () => DeepRead.util.copyToClipboard(translations.join("\n\n")) },
          eligible && { id: "regenerate", label: DeepRead.bilingual("重新生成讲解", "Regenerate explanation"), action: () => {
            session.explainParagraph(key).catch((e) => session._notify(DeepRead.util.formatError(e), "error"));
          } },
          { separator: true },
          session.previousCard(key) && { id: "merge", label: DeepRead.bilingual("与上一张合并", "Merge with previous"), restoreFocus: false, action: () => {
            session.mergeCardWithPrevious(key); focusSummary(key);
          } },
          session.groupMembers(key).length > 1 && { id: "split", label: DeepRead.bilingual("拆开合并卡片", "Split merged card"), restoreFocus: false, action: () => {
            session.splitCard(key); focusSummary(key);
          } },
          { id: "hide", label: DeepRead.bilingual("隐藏此卡片", "Hide this card"), danger: true, restoreFocus: false, action: () => {
            session.setCardHidden(key, true);
            this.pdfWin?.focus();
          } },
        ], { label: DeepRead.bilingual("卡片操作", "Card actions"), relatedDocument: this.pdfWin?.document,
          outsideDocument: (session.reader._window || Zotero.getMainWindow())?.document });
      });
      more.setAttribute("data-dr-action", "more");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      head.append(actions);
      const headWrap = el(doc, "div", "dr-phead");
      headWrap.append(head);
      node.append(headWrap);

      const sources = el(doc, "div", "dr-sources");
      sources.append(el(doc, "span", "dr-muted", DeepRead.bilingual("核对原文", "Check source")));
      for (const source of paras) {
        const sourceItem = el(doc, "span", "dr-source-item");
        const sourceKey = `p_${source.pageIndex}_${source.paragraphIndex}`;
        this._button(sourceItem, DeepRead.Rail.blockLabel(source), DeepRead.bilingual("定位并标出原文段落", "Locate and highlight the source paragraph"), () => {
          session.navigateToParagraph(source).catch((error) => session._notify(DeepRead.util.formatError(error), "error"));
        }).setAttribute("data-dr-action", `source:${source.pageIndex}:${source.paragraphIndex}`);
        const marked = session.needsReview(sourceKey);
        const review = this._button(sourceItem, DeepRead.bilingual("待弄懂", "Revisit"),
          `${DeepRead.Rail.blockLabel(source)} · ${DeepRead.bilingual(marked ? "取消待弄懂标记" : "标记待弄懂，不调用 AI", marked ? "Remove revisit flag" : "Flag for later; no AI request")}`,
          () => session.setNeedsReview(sourceKey, !session.needsReview(sourceKey)));
        review.classList.add("dr-review-toggle");
        review.setAttribute("aria-pressed", String(marked));
        review.setAttribute("data-dr-action", `review:${sourceKey}`);
        sources.append(sourceItem);
      }
      node.append(sources);

      // Body: the AI's explanation of the paragraph.
      const explanation = session.explanation(key);
      if (explanation) {
        const body = el(doc, "div", "dr-explain");
        body.append(el(doc, "div", "dr-card-section", DeepRead.bilingual("AI 讲解", "AI explanation")));
        body.append(DeepRead.Markdown.render(doc, explanation));
        node.append(body);
      }
      else if (session.isExplaining(key)) {
        node.append(el(doc, "div", "dr-explain dr-explain-pending", DeepRead.bilingual("AI 讲解生成中…", "Writing the explanation…")));
      }
      else if (eligible && session.hasResults) {
        const missing = el(doc, "div", "dr-explain dr-explain-missing");
        const link = el(doc, "a", "", DeepRead.bilingual("生成 AI 讲解", "Explain this paragraph"));
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          session.explainParagraph(key).catch((err) => session._notify(DeepRead.util.formatError(err), "error"));
        });
        missing.append(link);
        node.append(missing);
      }

      // Guided reading's judgements on these paragraphs (load-bearing, hedging, claim status).
      const guideNotes = session.guideNotesForKey?.(key) || [];
      if (guideNotes.length) {
        const box = el(doc, "div", "dr-guide-notes");
        for (const note of guideNotes.slice(0, 4)) {
          const row = el(doc, "div", `dr-guide-note dr-gn-${note.kind}`);
          row.append(el(doc, "span", "dr-gn-label", note.label));
          if (note.text) row.append(el(doc, "span", "dr-gn-text", note.text));
          box.append(row);
        }
        box.title = DeepRead.bilingual("来自带读 · 点击打开带读", "From the guided reading · click to open it");
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          session.guidePanel?.open(note0Step(guideNotes[0]));
        });
        node.append(box);
      }

      const points = paras.flatMap((p) => (p.points || []).map((point) => ({ point, owner: p })));
      if (points.length) {
        const list = el(doc, "ul", "dr-points");
        for (const { point, owner } of points) {
          const li = el(doc, "li");
          const pointLevel = session.pointLevel(point);
          const color = session.levelColor(pointLevel);
          li.dataset.level = String(pointLevel);
          li.classList.toggle("dr-hl", !!color);
          if (color) li.style.setProperty("--dr-hl", color);
          li.title = DeepRead.bilingual("单击换荧光笔颜色（颜色和次数在设置或「功能」菜单里改）",
            "Click for the next highlighter colour (colours are set in the settings or the Features menu)");
          li.append(el(doc, "span", "", point.summary || ""));
          li.addEventListener("pointerenter", () => this.overlay._drawHover(owner, point.id));
          li.addEventListener("pointerleave", () => this.overlay._drawHover(owner));
          li.addEventListener("click", (e) => {
            e.stopPropagation();
            session.setPointImportance(point.id, session.nextPointLevel(point));
          });
          list.append(li);
        }
        node.append(list);
      }

      // The translation is one part of the card, folded by default.
      if (translations.length) {
        const open = this._translationOpen(key);
        const wrap = el(doc, "div", "dr-trwrap");
        const toggle = el(doc, "button", "dr-trtoggle", `${open ? "▾" : "▸"} ${DeepRead.bilingual("译文", "Translation")}`);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("data-dr-action", "translation");
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.trToggled.has(key)) this.trToggled.delete(key);
          else this.trToggled.add(key);
          this._invalidate(key);
        });
        wrap.append(toggle);
        if (open) {
          const body = el(doc, "div", "dr-trbody");
          for (const { paragraph: owner, text } of this.overlay.translationEntriesFor(paras)) {
            const part = el(doc, "div", "dr-trpart");
            part.append(this.overlay._translationContent(owner, text));
            body.append(part);
          }
          wrap.append(body);
        }
        node.append(wrap);
      }

      // The reader's own understanding: always expanded, never folded.
      const note = session.paragraphNote(key);
      if (this.noteEditing === key) {
        node.append(this._noteEditor(note, (value) => {
          this.noteEditing = null;
          this._clearDrafts(`note:${key}`);
          session.setParagraphNote(key, value);
          this._invalidate(key);
        }, () => {
          this.noteEditing = null;
          this._clearDrafts(`note:${key}`);
          this._invalidate(key);
        }, `note:${key}`));
      }
      else if (note) {
        const block = el(doc, "div", "dr-note");
        block.append(el(doc, "div", "dr-note-label", DeepRead.bilingual("我的理解", "My understanding")), el(doc, "div", "dr-note-text", note));
        block.title = DeepRead.bilingual("单击编辑", "Click to edit");
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          this.noteEditing = key;
          this._invalidate(key);
        });
        node.append(block);
      }

      for (const member of paras.slice(1)) {
        const noteKey = `p_${member.pageIndex}_${member.paragraphIndex}`;
        const memberNote = session.paragraphNote(noteKey);
        if (memberNote) node.append(el(doc, "div", "dr-note", `${session.groupLabel(noteKey)} · ${memberNote}`));
      }
      node.onpointerenter = () => (members ? this.overlay.outlineParagraphs(paras) : this.overlay._drawHover(paragraph));
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    /** Bind a textarea to a draft slot so typed text survives re-rendering the card. */
    _draft(field, id, initial) {
      field.value = this.drafts.has(id) ? this.drafts.get(id) : (initial || "");
      field.addEventListener("input", () => this.drafts.set(id, field.value));
    }

    _clearDrafts(prefix) {
      for (const id of [...this.drafts.keys()]) if (id.startsWith(prefix)) this.drafts.delete(id);
    }

    _noteEditor(value, onSave, onCancel, draftID) {
      const doc = this.readerDoc;
      const wrap = el(doc, "div", "dr-note dr-note-editing");
      wrap.append(el(doc, "div", "dr-note-label", DeepRead.bilingual("我的理解", "My understanding")));
      const area = el(doc, "textarea");
      area.rows = 3;
      area.placeholder = DeepRead.bilingual("写下你对这段的理解、疑问或联想…（Ctrl+Enter 保存）", "Your understanding, questions or connections… (Ctrl+Enter to save)");
      if (draftID) this._draft(area, draftID, value);
      else area.value = value || "";
      area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSave(area.value);
        }
        else if (e.key === "Escape") onCancel();
      });
      area.addEventListener("input", () => this.schedule(true));
      const buttons = el(doc, "div", "dr-fc-buttons");
      this._button(buttons, DeepRead.bilingual("保存", "Save"), "", () => onSave(area.value)).classList.add("dr-primary");
      this._button(buttons, DeepRead.bilingual("取消", "Cancel"), "", () => onCancel());
      wrap.append(area, buttons);
      wrap.addEventListener("click", (e) => e.stopPropagation());
      setTimeout(() => area.focus(), 0);
      return wrap;
    }

    /** Figure/table card: label, title, thumbnail cut from the rendered page, and reading steps. */
    _fillFigure(node, figure, item) {
      const doc = this.readerDoc;
      const session = this.session;
      node.classList.add("dr-figure");
      node.dataset.kind = figure.kind === "table" ? "table" : "figure";
      const focus = this.figureFocus?.id === figure.id ? this.figureFocus : null;
      node.classList.toggle("dr-linked", !!focus);
      const side = item?.side || this._sideOfKey?.get(`g_${figure.id}`) || "right";
      const compact = (this.figureCollapsed?.has(figure.id) || ((session.focusReading || !!this.compactPages?.has(`${side}:${figure.pageIndex}`)) && !this.figureExpanded?.has(figure.id))) && this.figureEditing !== figure.id;
      node.classList.toggle("dr-compact", compact);
      const guide = session.figureGuide(figure.id);
      const head = el(doc, "div", "dr-fhead");
      const label = DeepRead.Rail.figureLabel(figure);
      head.append(el(doc, "span", "dr-flabel", label));
      head.append(el(doc, "span", "dr-ftitle", guide?.title || figure.title || ""));
      const toggle = this._button(head, compact ? "▸" : "▾", DeepRead.bilingual("展开 / 收起图表卡片", "Open / close figure card"), () => {
        this.figureExpanded = this.figureExpanded || new Set();
        this.figureCollapsed = this.figureCollapsed || new Set();
        if (compact) { this.figureExpanded.add(figure.id); this.figureCollapsed.delete(figure.id); }
        else { this.figureExpanded.delete(figure.id); this.figureCollapsed.add(figure.id); }
        this._invalidate(`g_${figure.id}`);
      });
      toggle.classList.add("dr-ftoggle");
      toggle.setAttribute("aria-expanded", String(!compact));
      const count = session.figureMentionCount(figure.id);
      if (count) head.append(el(doc, "span", "dr-fcount", DeepRead.bilingual(`提到 ${count} 次`, `${count} mentions`)));
      node.append(head);

      // Caption-only figures (no image region found) have nothing to show as a thumbnail.
      if (!figure.captionOnly) {
        const thumb = el(doc, "canvas", "dr-fthumb");
        thumb.setAttribute("role", "img");
        thumb.setAttribute("aria-label", `${label} ${figure.title || ""}`);
        node.append(thumb);
        this._drawThumb(thumb, figure);
      }

      const body = el(doc, "div", "dr-fbody");
      if (guide?.steps?.length) {
        const list = el(doc, "ol", "dr-fsteps");
        guide.steps.forEach((step, i) => {
          const li = el(doc, "li");
          const on = focus && (focus.panel ? step.panel === focus.panel : false);
          li.classList.toggle("dr-on", !!on);
          li.append(el(doc, "span", "dr-fnum", String(i + 1)));
          const text = el(doc, "span", "dr-ftext");
          text.append(DeepRead.Overlay.inlineMarkdown(doc, step.text || ""));
          li.append(text);
          list.append(li);
        });
        const details = el(doc, "details", "dr-figure-guide");
        details.open = this.figureGuideOpen?.has(figure.id) || false;
        details.append(el(doc, "summary", "", DeepRead.bilingual("查看 AI 读图步骤", "Show AI reading steps")), list);
        details.addEventListener("toggle", () => {
          this.figureGuideOpen = this.figureGuideOpen || new Set();
          if (details.open) this.figureGuideOpen.add(figure.id);
          else this.figureGuideOpen.delete(figure.id);
          this.schedule(true);
        });
        body.append(details);
      }
      else if (session.explainingFigures) {
        body.append(el(doc, "div", "dr-muted", DeepRead.bilingual("读图步骤生成中…", "Writing the reading guide…")));
      }
      else if (figure.caption) {
        body.append(el(doc, "div", "dr-fcaption", figure.caption.length > 160 ? `${figure.caption.slice(0, 160)}…` : figure.caption));
      }
      node.append(body);
      const evidence = el(doc, "div", "dr-evidence");
      const note = session.figureNote(figure.id);
      evidence.append(el(doc, "strong", "", DeepRead.bilingual("我的证据笔记", "My evidence notes")));
      if (this.figureEditing === figure.id) {
        const fields = {};
        for (const field of DeepRead.Reading.FIELDS) {
          const label = el(doc, "label", "", DeepRead.bilingual(field.zh, field.en));
          const input = el(doc, "textarea");
          input.rows = 2;
          input.maxLength = 6000;
          input.dataset.field = field.key;
          this._draft(input, `evidence:${figure.id}:${field.key}`, note?.[field.key]);
          input.addEventListener("input", () => this.schedule(true));
          input.addEventListener("keydown", (e) => e.stopPropagation());
          fields[field.key] = input;
          label.append(input);
          evidence.append(label);
        }
        this._button(evidence, DeepRead.bilingual("保存", "Save"), "", () => {
          this.figureEditing = null;
          this._clearDrafts(`evidence:${figure.id}:`);
          session.setFigureNote(figure, Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value])));
          this._invalidate(`g_${figure.id}`);
        }).classList.add("dr-evidence-save");
        this._button(evidence, DeepRead.bilingual("取消", "Cancel"), "", () => {
          this.figureEditing = null;
          this._clearDrafts(`evidence:${figure.id}:`);
          this._invalidate(`g_${figure.id}`);
        });
      }
      else {
        if (note) for (const field of DeepRead.Reading.FIELDS) if (note[field.key]) {
          evidence.append(el(doc, "div", "dr-muted", DeepRead.bilingual(field.zh, field.en)), el(doc, "p", "", note[field.key]));
        }
        this._button(evidence, DeepRead.bilingual(note ? "编辑笔记" : "先写我的判断", note ? "Edit notes" : "Write my interpretation"), "", () => {
          this.figureEditing = figure.id;
          this._invalidate(`g_${figure.id}`);
        }).classList.add("dr-evidence-edit");
      }
      evidence.addEventListener("click", (e) => e.stopPropagation());
      node.append(evidence);
      node.title = DeepRead.bilingual("单击跳到图表", "Click to go to the figure");
      node.onclick = (event) => {
        if (event.target?.closest("button, textarea, input, select, a, summary, details")) return;
        const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
        session.reader.navigate(rect ? { position: { pageIndex: figure.pageIndex, rects: [rect] } } : { pageIndex: figure.pageIndex });
      };
      node.onpointerenter = () => {
        const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
        if (rect) this.overlay._drawHover({ pageIndex: figure.pageIndex, bbox: rect, rects: [rect], points: [] });
      };
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    /** Copy the figure's region from the page canvas pdf.js already rendered (blank until it has). */
    _drawThumb(canvas, figure) {
      const width = Math.max(120, (this.root?.clientWidth || 280) - 44);
      const [x1, y1, x2, y2] = figure.bbox || [0, 0, 1000, 1000];
      const aspect = Math.max(0.15, (y2 - y1) / Math.max(1, x2 - x1));
      const height = Math.min(180, Math.round(width * aspect));
      const ratio = this.readerWin?.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      try {
        const div = this.app?.pdfViewer?.getPageView(figure.pageIndex)?.div;
        const source = div?.querySelector("canvas");
        if (!source || !source.width) return;
        const src = Components.utils.unwaiveXrays ? Components.utils.unwaiveXrays(source) : source;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(src,
          (x1 / 1000) * source.width, (y1 / 1000) * source.height,
          ((x2 - x1) / 1000) * source.width, ((y2 - y1) / 1000) * source.height,
          0, 0, canvas.width, canvas.height);
        canvas.dataset.drawn = "1";
      }
      catch (e) {
        DeepRead.log("figure thumbnail failed", String(e));
      }
    }

    linkParagraph(paragraph) {
      if (!this.root) return;
      const key = paragraph ? this.session.groupLead(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`) : null;
      for (const [k, card] of this.cards) card.el.classList.toggle("dr-linked", k === key);
      // A paragraph that mentions a figure ("Fig. 3(b)") lights up that figure's card and step.
      const focus = paragraph ? DeepRead.Rail.figureMention(paragraph.paragraphText || "", this.session.figures()) : null;
      const before = this.figureFocus?.id;
      if (focus?.id !== before || focus?.panel !== this.figureFocus?.panel) {
        this.figureFocus = focus;
        for (const id of [before, focus?.id]) if (id && this.cards.get(`g_${id}`)) this.cards.get(`g_${id}`).sig = null;
        this.schedule();
      }
    }
  };
})();

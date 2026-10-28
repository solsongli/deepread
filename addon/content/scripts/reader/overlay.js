/*
 * In-reader presentation of deep-read results.
 *
 * - Passive layers inside each pdf.js page (pointer-events: none): key-point highlights,
 *   hover outlines and the hover translation (a panel right below / above the paragraph, typeset like
 *   the original so both can be read; hold Alt to hide it).
 * - Interactive paragraph cards live in the *outer* reader document (reader.html), because the
 *   reader registers capture-phase pointer handlers on the PDF window for text selection.
 *
 * Geometry: rects are PDF user-space [x1, y1, x2, y2]; they are mapped to percentages of the
 * page box through the page viewport transform, so layers stay correct while zooming.
 *
 * License: AGPL-3.0-or-later. Interaction design follows Vibero (AGPL-3.0, a Zotero fork).
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const HIGHLIGHT_ALPHA = 0.28; // highlighter colours (session.levelColor) drawn over the PDF text
  const FIT_MIN = 0.82; // preserve legibility while fitting the original paragraph box
  const FIT_MAX = 1.0;
  const HOVER_POINT_COLOR = "rgba(251, 191, 36, 0.32)";
  const SHOW_DELAY = 140;
  const HIDE_DELAY = 280;
  const TRANSLATION_DELAY = 160; // dwell before the hovered paragraph turns into its translation
  const CLICK_SLOP = 5; // px a press may move and still count as a click

  const PAGE_CSS = `
.deepread-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.deepread-layer .dr-rect { position: absolute; border-radius: 2px; mix-blend-mode: multiply; }
.deepread-layer .dr-outline { position: absolute; border-radius: 4px;
  box-shadow: 0 0 0 1.5px rgba(251, 191, 36, 0.85); background: rgba(251, 191, 36, 0.06); }
.deepread-layer .dr-dim { position: absolute; background: rgba(255, 255, 255, 0.6); border-radius: 2px; }
.deepread-layer .dr-dim.dr-dim-strong { background: rgba(255, 255, 255, 0.78); }
.deepread-layer .dr-keyline { position: absolute; border-bottom: 2px solid rgba(217, 119, 6, 0.8); }
.deepread-layer .dr-translation { position: absolute; box-sizing: border-box; padding: 2px 4px;
  background: #fffef9; color: #111; border-radius: 4px;
  border: 1px solid rgba(251, 191, 36, 0.7); box-shadow: 0 3px 12px rgba(0, 0, 0, 0.16);
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
  text-align: justify; text-align-last: start; overflow-wrap: anywhere; hyphens: none;
  pointer-events: auto; overflow: auto; scrollbar-width: thin; overscroll-behavior: contain; }
.deepread-layer .dr-translation.dr-title { font-weight: 700; text-align: start; }
.deepread-layer .dr-translation p { margin: 0; }
.deepread-layer .dr-translation .katex { font-size: 1em; }
:root[data-color-scheme="dark"] .deepread-layer .dr-rect { mix-blend-mode: screen; }
:root[data-color-scheme="dark"] .deepread-layer .dr-translation { background: #22252a; color: #e6e6e6; }
`;

  const CARD_CSS = `
.deepread-card { position: fixed; z-index: 2147483000; width: 340px; max-height: 70vh; overflow: auto;
  box-sizing: border-box; padding: 10px 12px 8px; border-radius: 10px;
  background: #ffffff; color: #1f2328; border: 1px solid rgba(0,0,0,0.10);
  box-shadow: 0 8px 28px rgba(0,0,0,0.16); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-card[hidden] { display: none; }
.deepread-card .dr-head { display: flex; gap: 8px; align-items: flex-start; }
.deepread-card .dr-summary { flex: 1; font-weight: 600; font-size: 13.5px; }
.deepread-card .dr-actions { display: flex; gap: 2px; flex-shrink: 0; }
.deepread-card .dr-actions button { border: none; background: transparent; color: #57606a; cursor: pointer;
  font-size: 12px; padding: 2px 5px; border-radius: 5px; }
.deepread-card .dr-actions button:hover { background: rgba(0,0,0,0.06); color: #1f2328; }
.deepread-card ol { margin: 8px 0 2px; padding: 0; list-style: none; }
.deepread-card li { position: relative; padding: 5px 6px 5px 16px; border-radius: 6px; cursor: pointer; }
.deepread-card li::before { content: ""; position: absolute; left: 6px; top: 12px; width: 5px; height: 5px;
  border-radius: 50%; background: #8c959f; }
.deepread-card li.dr-hl::before { background: var(--dr-hl); }
.deepread-card li.dr-hl { background: color-mix(in srgb, var(--dr-hl) 16%, transparent); }
.deepread-card li:hover { background: rgba(251, 191, 36, 0.16); }
.deepread-card .dr-point-summary { font-weight: 500; }
.deepread-card { font-size: var(--dr-card-font, 13px); }
.deepread-card .dr-summary { font-size: 1.04em; }
.deepread-card .dr-explain { margin-top: 6px; }
.deepread-card .dr-explain p { margin: 0.3em 0; }
.deepread-card .dr-explain-pending { color: #8c959f; font-style: italic; }
.deepread-card .dr-trtoggle { display: inline-block; margin-top: 6px; font-size: 0.9em; color: #6b7280; cursor: pointer; user-select: none; }
.deepread-card .dr-trbody { margin-top: 2px; padding: 4px 8px; border-left: 3px solid #93c5fd; border-radius: 4px;
  background: rgba(59,130,246,0.06); font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif; }
.deepread-card .dr-point-translation { color: #424a53; margin-top: 2px; }
.deepread-card .dr-foot { margin-top: 4px; font-size: 11px; color: #8c959f; }
.deepread-card .dr-hnote { margin-top: 6px; padding: 4px 8px; border-radius: 6px; border-left: 3px solid #10b981;
  background: rgba(16,185,129,0.08); white-space: pre-wrap; }
.deepread-card .dr-hnote-label { font-size: 11px; font-weight: 700; color: #047857; }
:root[data-color-scheme="dark"] .deepread-card { background: #2a2d32; color: #e6e6e6; border-color: rgba(255,255,255,0.12); }
:root[data-color-scheme="dark"] .deepread-card .dr-actions button { color: #a0a7b0; }
:root[data-color-scheme="dark"] .deepread-card .dr-actions button:hover { background: rgba(255,255,255,0.08); color: #fff; }
:root[data-color-scheme="dark"] .deepread-card .dr-point-translation { color: #c5c9cf; }
`;

  function rgba(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})` : "";
  }

  function apply(t, x, y) {
    return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  }

  function invert(t) {
    const det = t[0] * t[3] - t[1] * t[2];
    if (!det) return null;
    return [
      t[3] / det, -t[1] / det, -t[2] / det, t[0] / det,
      (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det,
    ];
  }

  function unionRect(rects) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) {
      x1 = Math.min(x1, r[0], r[2]);
      y1 = Math.min(y1, r[1], r[3]);
      x2 = Math.max(x2, r[0], r[2]);
      y2 = Math.max(y2, r[1], r[3]);
    }
    return Number.isFinite(x1) ? [x1, y1, x2, y2] : null;
  }

  /** One line/paragraph of LLM text (may hold **bold** and $math$) as an inline fragment for `doc`. */
  function inlineMarkdown(doc, text) {
    try {
      let frag = DeepRead.Markdown.render(doc, text);
      const only = frag.childNodes.length === 1 ? frag.firstChild : null;
      if (only?.localName === "p") {
        const inner = doc.createDocumentFragment();
        inner.append(...only.childNodes);
        frag = inner;
      }
      return frag;
    }
    catch (e) {
      const frag = doc.createDocumentFragment();
      frag.append(String(text || ""));
      return frag;
    }
  }

  function inRect(r, x, y, pad = 1.5) {
    return x >= Math.min(r[0], r[2]) - pad && x <= Math.max(r[0], r[2]) + pad
      && y >= Math.min(r[1], r[3]) - pad && y <= Math.max(r[1], r[3]) + pad;
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.Overlay = class Overlay {
    constructor(session) {
      this.session = session;
      this.pages = new Map(); // pageIndex → paragraphs (with bbox)
      this.options = {
        highlights: DeepRead.prefs.get("view.highlights") !== false,
        hoverCards: DeepRead.prefs.get("view.hoverCards") !== false,
        translationPopup: DeepRead.prefs.get("view.translationPopup") !== false,
      };
      this.hoverPara = null;
      this.cardPara = null;
      this.trPara = null; // hovered paragraph currently shown as its translation
      this._suppressPara = null; // pressed/selected paragraph: show the original until the pointer leaves it
      this._trContent = new WeakMap(); // paragraph → rendered translation (DocumentFragment)
      this.altDown = false;
      this._timers = {};
      this._cleanup = [];
      this.attached = false;
    }

    /** @param view reader._internalReader._primaryView (content object, x-ray waived) */
    attach(view) {
      this.detach();
      const pdfWin = view._iframeWindow;
      const readerWin = this.session.reader._iframeWindow;
      if (!pdfWin || !readerWin) throw new Error("reader view not ready");
      this.view = view;
      this.pdfWin = pdfWin;
      this.pdfDoc = pdfWin.document;
      this.app = (pdfWin.wrappedJSObject || pdfWin).PDFViewerApplication;
      this.readerDoc = readerWin.document;
      this.iframeEl = view._iframe;

      this._injectStyle(this.pdfDoc, "deepread-page-css", PAGE_CSS);
      // Translations may contain inline math rendered with KaTeX.
      DeepRead.util.injectStylesheet(this.pdfDoc, "chrome://deepread/content/lib/katex/katex.min.css", "deepread-katex-css");
      DeepRead.util.injectStylesheet(this.readerDoc, "chrome://deepread/content/lib/katex/katex.min.css", "deepread-katex-css");
      this._injectStyle(this.readerDoc, "deepread-card-css", CARD_CSS);

      const onPointerMove = (event) => this._onPointerMove(event);
      const onPointerLeave = () => this._scheduleHide();
      const onKey = (event) => this._onKey(event);
      const onScroll = () => this._hideCard(true);
      const onPointerDown = (event) => this._onPointerDown(event);
      const onPointerUp = (event) => this._onPointerUp(event);
      this.pdfDoc.addEventListener("pointermove", onPointerMove, { passive: true });
      this.pdfWin.addEventListener("pointerdown", onPointerDown, true);
      this.pdfWin.addEventListener("pointerup", onPointerUp, true);
      this.pdfDoc.documentElement.addEventListener("pointerleave", onPointerLeave);
      this.pdfWin.addEventListener("keydown", onKey, true);
      this.pdfWin.addEventListener("keyup", onKey, true);
      this.pdfWin.addEventListener("blur", onKey, true);
      const container = this.pdfDoc.getElementById("viewerContainer");
      container?.addEventListener("scroll", onScroll, { passive: true });
      this._cleanup.push(() => {
        this.pdfDoc.removeEventListener("pointermove", onPointerMove);
        this.pdfWin.removeEventListener("pointerdown", onPointerDown, true);
        this.pdfWin.removeEventListener("pointerup", onPointerUp, true);
        this.pdfDoc.documentElement?.removeEventListener("pointerleave", onPointerLeave);
        this.pdfWin.removeEventListener("keydown", onKey, true);
        this.pdfWin.removeEventListener("keyup", onKey, true);
        this.pdfWin.removeEventListener("blur", onKey, true);
        container?.removeEventListener("scroll", onScroll);
      });

      // Re-create page layers whenever pdf.js (re)renders a page; zooming resets page DOM.
      const onRendered = Components.utils.exportFunction((event) => {
        try {
          this._renderPage(event.pageNumber - 1);
        }
        catch (e) {
          DeepRead.log("overlay pagerendered failed", String(e));
        }
      }, this.pdfWin);
      const onRotation = Components.utils.exportFunction(() => this.renderAllPages(), this.pdfWin);
      this.app.eventBus.on("pagerendered", onRendered);
      this.app.eventBus.on("rotationchanging", onRotation);
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagerendered", onRendered);
          this.app.eventBus.off("rotationchanging", onRotation);
        }
        catch (e) {}
      });

      this.attached = true;
      this.renderAllPages();
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      for (const timer of Object.values(this._timers)) clearTimeout(timer);
      this._timers = {};
      if (this.pdfDoc) {
        for (const layer of this.pdfDoc.querySelectorAll(".deepread-layer")) layer.remove();
      }
      this.card?.remove();
      this.card = null;
      this.attached = false;
    }

    setData(hierarchicalData) {
      this.pages = new Map();
      for (const page of hierarchicalData || []) {
        const paragraphs = [];
        for (const paragraph of page.paragraphs || []) {
          const rects = (paragraph.rects || []).filter((r) => Array.isArray(r) && r.length === 4);
          const hasContent = paragraph.paragraphSummary || (paragraph.points || []).some((p) => p.summary || p.translation);
          if (!rects.length || !hasContent) continue;
          paragraphs.push({ ...paragraph, pageIndex: page.pageIndex, rects, bbox: unionRect(rects) });
        }
        this.pages.set(page.pageIndex, paragraphs);
      }
      this._hideCard(true);
      this.renderAllPages();
    }

    /** When the margin rail is visible, floating hover cards are replaced by rail highlighting. */
    setRailActive(active) {
      this.railActive = !!active;
      if (active) this._hideCard(true);
    }

    setOptions(options) {
      Object.assign(this.options, options);
      if (!this.options.hoverCards) this._hideCard(true);
      this.renderAllPages();
    }

    renderAllPages() {
      if (!this.attached) return;
      const count = this.app?.pdfViewer?.pagesCount || 0;
      for (let i = 0; i < count; i++) {
        this._renderPage(i);
      }
    }

    /* ---------- geometry ---------- */

    _geometry(pageIndex) {
      const pageView = this.app?.pdfViewer?.getPageView(pageIndex);
      const viewport = pageView?.viewport;
      if (!pageView?.div || !viewport) return null;
      return { div: pageView.div, t: Array.from(viewport.transform), w: viewport.width, h: viewport.height };
    }

    _toPercent(geom, rect) {
      const [ax, ay] = apply(geom.t, rect[0], rect[1]);
      const [bx, by] = apply(geom.t, rect[2], rect[3]);
      return {
        left: (Math.min(ax, bx) / geom.w) * 100,
        top: (Math.min(ay, by) / geom.h) * 100,
        width: (Math.abs(bx - ax) / geom.w) * 100,
        height: (Math.abs(by - ay) / geom.h) * 100,
      };
    }

    _clientToPdf(geom, clientX, clientY) {
      const box = geom.div.getBoundingClientRect();
      const left = box.left + geom.div.clientLeft;
      const top = box.top + geom.div.clientTop;
      const px = ((clientX - left) / (geom.div.clientWidth || 1)) * geom.w;
      const py = ((clientY - top) / (geom.div.clientHeight || 1)) * geom.h;
      const inv = invert(geom.t);
      return inv ? apply(inv, px, py) : null;
    }

    /** PDF rect of a content-list bbox (per-mille, top-left origin) on a page, or null if the page is unknown. */
    permilleRect(pageIndex, bbox) {
      const pageView = this.app?.pdfViewer?.getPageView(pageIndex);
      const view = pageView?.pdfPage?.view ? Array.from(pageView.pdfPage.view) : null;
      if (!view || !Array.isArray(bbox) || bbox.length < 4) return null;
      const w = view[2] - view[0];
      const h = view[3] - view[1];
      return [view[0] + (bbox[0] / 1000) * w, view[3] - (bbox[3] / 1000) * h, view[0] + (bbox[2] / 1000) * w, view[3] - (bbox[1] / 1000) * h];
    }

    /** Client rect (in the outer reader document) of a PDF rect on a page. */
    _rectInReaderDoc(pageIndex, rect) {
      const geom = this._geometry(pageIndex);
      if (!geom) return null;
      const pct = this._toPercent(geom, rect);
      const box = geom.div.getBoundingClientRect();
      const frame = this.iframeEl.getBoundingClientRect();
      const left = frame.left + box.left + geom.div.clientLeft;
      const top = frame.top + box.top + geom.div.clientTop;
      const w = geom.div.clientWidth;
      const h = geom.div.clientHeight;
      return {
        left: left + (pct.left / 100) * w,
        top: top + (pct.top / 100) * h,
        right: left + ((pct.left + pct.width) / 100) * w,
        bottom: top + ((pct.top + pct.height) / 100) * h,
        pageLeft: frame.left + box.left,
        pageRight: frame.left + box.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        frameTop: frame.top,
        frameBottom: frame.bottom,
      };
    }

    /* ---------- page layers ---------- */

    _layer(pageIndex) {
      const geom = this._geometry(pageIndex);
      if (!geom) return null;
      let layer = geom.div.querySelector(":scope > .deepread-layer");
      if (!layer) {
        layer = el(this.pdfDoc, "div", "deepread-layer");
        layer.append(el(this.pdfDoc, "div", "dr-persistent"), el(this.pdfDoc, "div", "dr-transient"));
        geom.div.append(layer);
      }
      return {
        layer, geom,
        persistent: layer.querySelector(":scope > .dr-persistent"),
        transient: layer.querySelector(":scope > .dr-transient"),
      };
    }

    _addRect(container, geom, rect, cls, color) {
      const pct = this._toPercent(geom, rect);
      const node = el(this.pdfDoc, "div", cls);
      node.style.left = `${pct.left}%`;
      node.style.top = `${pct.top}%`;
      node.style.width = `${pct.width}%`;
      node.style.height = `${pct.height}%`;
      if (color) node.style.background = color;
      container.append(node);
      return node;
    }

    _renderPage(pageIndex) {
      const paragraphs = this.pages.get(pageIndex) || [];
      const geom = this._geometry(pageIndex);
      if (!geom) return;
      if (!paragraphs.length) {
        geom.div.querySelector(":scope > .deepread-layer")?.remove();
        return;
      }
      const ctx = this._layer(pageIndex);
      if (!ctx) return;
      ctx.persistent.replaceChildren();
      if (this.options.highlights) {
        for (const paragraph of paragraphs) {
          for (const point of paragraph.points || []) {
            const color = rgba(this.session.levelColor(this.session.highlightLevel(point)), HIGHLIGHT_ALPHA);
            if (!color) continue;
            for (const rect of point.rects || []) {
              this._addRect(ctx.persistent, ctx.geom, rect, "dr-rect", color);
            }
          }
        }
      }
      // Skim layers: fade minor paragraphs (all text in "margin only"), underline key sentences.
      const depth = this.session.skimDepth;
      if (depth && depth !== "full" && this.session.hasResults) {
        const { tier, keyPoints } = this.session.skimTiers();
        for (const paragraph of paragraphs) {
          const t = tier.get(`p_${pageIndex}_${paragraph.paragraphIndex}`);
          if (!t || !paragraph.bbox) continue;
          if (depth === "margin" || t === "minor") {
            const [x1, y1, x2, y2] = paragraph.bbox;
            this._addRect(ctx.persistent, ctx.geom, [x1 - 2, y1 - 2, x2 + 2, y2 + 2], depth === "margin" ? "dr-dim dr-dim-strong" : "dr-dim");
          }
          else if (t === "key") {
            for (const point of paragraph.points || []) {
              if (!keyPoints.has(point.id)) continue;
              for (const rect of point.rects || []) this._addRect(ctx.persistent, ctx.geom, rect, "dr-keyline");
            }
          }
        }
      }
      // Restore transient state for the hovered paragraph after a re-render.
      ctx.transient.replaceChildren();
      if (this.hoverPara && this.hoverPara.pageIndex === pageIndex) {
        this._drawHover(this.hoverPara);
      }
    }

    _clearTransient() {
      if (!this.pdfDoc) return;
      for (const node of this.pdfDoc.querySelectorAll(".deepread-layer .dr-transient")) {
        node.replaceChildren();
      }
    }

    _drawHover(paragraph, pointId = null) {
      this._clearTransient();
      const ctx = this._layer(paragraph.pageIndex);
      if (!ctx) return;
      if (pointId) {
        const point = (paragraph.points || []).find((p) => p.id === pointId);
        for (const rect of point?.rects || []) {
          this._addRect(ctx.transient, ctx.geom, rect, "dr-rect", HOVER_POINT_COLOR);
        }
        return;
      }
      if (paragraph === this.trPara && this._translationAllowed(paragraph) && this._drawTranslation(ctx, paragraph)) return;
      const pad = 2;
      const [x1, y1, x2, y2] = paragraph.bbox;
      this._addRect(ctx.transient, ctx.geom, [x1 - pad, y1 - pad, x2 + pad, y2 + pad], "dr-outline");
    }

    /** Outline every paragraph of a merged card (hovering the card). */
    outlineParagraphs(paragraphs) {
      this._clearTransient();
      const pad = 2;
      for (const paragraph of paragraphs || []) {
        const ctx = paragraph?.bbox && this._layer(paragraph.pageIndex);
        if (!ctx) continue;
        const [x1, y1, x2, y2] = paragraph.bbox;
        this._addRect(ctx.transient, ctx.geom, [x1 - pad, y1 - pad, x2 + pad, y2 + pad], "dr-outline");
      }
    }

    /** A page is two-column when it has narrow body-text blocks on both halves. */
    isTwoColumn(pageIndex) {
      if (this._columnsFor !== this.pages) {
        this._columnsFor = this.pages;
        this._columns = new Map();
      }
      if (!this._columns.has(pageIndex)) {
        const geom = this._geometry(pageIndex);
        if (!geom) return false;
        let left = 0;
        let right = 0;
        for (const paragraph of this.pages.get(pageIndex) || []) {
          if (!String(paragraph.paragraphType || "text").startsWith("text") || !paragraph.bbox) continue;
          const pct = this._toPercent(geom, paragraph.bbox);
          if (pct.width > 60) continue;
          if (pct.left + pct.width / 2 < 50) left++;
          else right++;
        }
        this._columns.set(pageIndex, left > 0 && right > 0);
      }
      return this._columns.get(pageIndex);
    }

    _translationAllowed(paragraph) {
      return this.options.translationPopup && !this.altDown && paragraph !== this._suppressPara
        && paragraph.paragraphType !== "equation";
    }

    _paragraphTranslation(paragraph) {
      const parts = (paragraph.points || []).map((p) => (p.translation || "").trim()).filter(Boolean);
      return parts.join(" ");
    }

    /**
     * Line metrics of a paragraph in page-div CSS px, from its line rects (sentence pieces that
     * share a line are merged): font size, line pitch, first-line indent.
     */
    _lineMetrics(geom, paragraph) {
      const k = (geom.div.clientWidth || geom.w) / geom.w;
      const boxes = [];
      for (const r of paragraph.rects || []) {
        const [ax, ay] = apply(geom.t, r[0], r[1]);
        const [bx, by] = apply(geom.t, r[2], r[3]);
        const box = { x1: Math.min(ax, bx) * k, x2: Math.max(ax, bx) * k, y1: Math.min(ay, by) * k, y2: Math.max(ay, by) * k };
        if (box.y2 - box.y1 > 1 && box.x2 - box.x1 > 1) boxes.push(box);
      }
      boxes.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
      const lines = [];
      for (const box of boxes) {
        const cy = (box.y1 + box.y2) / 2;
        const line = lines.find((l) => cy > l.y1 && cy < l.y2);
        if (line) {
          line.x1 = Math.min(line.x1, box.x1);
          line.x2 = Math.max(line.x2, box.x2);
        }
        else lines.push({ ...box });
      }
      const median = (values, fallback) => {
        const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : fallback;
      };
      const visual = ["image", "table", "chart", "figure"].includes(paragraph.paragraphType);
      // A fallback image rectangle is NOT a line of text. PDF user units scale with
      // the viewport transform as well as the rendered page-div width.
      const pdfScale = Math.hypot(geom.t[0], geom.t[1]) * k;
      const sourceSize = paragraph.typography?.fontSize;
      const fallback = (visual ? 9 : 10) * pdfScale;
      const plausible = lines.filter((l) => l.y2 - l.y1 <= 24 * pdfScale);
      const height = sourceSize > 0 ? sourceSize * pdfScale
        : median(plausible.map((l) => l.y2 - l.y1), fallback);
      lines.sort((a, b) => a.y1 - b.y1);
      const pitches = [];
      for (let i = 1; i < lines.length; i++) {
        const d = (lines[i].y1 + lines[i].y2) / 2 - (lines[i - 1].y1 + lines[i - 1].y2) / 2;
        if (d > height * 0.6 && d < height * 3) pitches.push(d);
      }
      // A Latin line box (ascent + descent) is ~0.9 em; CJK glyphs fill their em, so an em of
      // about the line-box height matches the original's visual size.
      const fontSize = visual ? Math.min(height, 12 * pdfScale) : height;
      const lineHeight = Math.max(fontSize * 1.15, Math.min(fontSize * 1.6, median(pitches, fontSize * 1.2)));
      const left = Math.min(...lines.map((l) => l.x1));
      const indent = lines.length > 1 && lines[0].x1 - left > fontSize * 0.8 ? lines[0].x1 - left : 0;
      return { fontSize, lineHeight, indent, lines: lines.length };
    }

    _translationContent(paragraph, text) {
      const cached = this._trContent.get(paragraph);
      let frag = cached?.text === text ? cached.frag : null;
      if (!frag) {
        frag = inlineMarkdown(this.pdfDoc, text);
        // CommonMark rejects closing emphasis after CJK punctuation immediately
        // followed by CJK text (e.g. **图 1：**结果). Repair literal markers in
        // sanitized text nodes only; never reinterpret HTML or formula/code nodes.
        const walker = this.pdfDoc.createTreeWalker(frag, 4);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
          if (node.parentElement?.closest("code, pre, .katex, math, strong, em")) continue;
          const value = node.nodeValue;
          const re = /(?<![\\*])(\*{1,3})([^*\n]+?)\1(?!\*)/g;
          const parts = this.pdfDoc.createDocumentFragment();
          let end = 0, match;
          while ((match = re.exec(value))) {
            parts.append(value.slice(end, match.index));
            const mark = el(this.pdfDoc, match[1].length === 1 ? "em" : "strong");
            if (match[1].length === 3) mark.append(el(this.pdfDoc, "em", "", match[2]));
            else mark.textContent = match[2];
            parts.append(mark);
            end = re.lastIndex;
          }
          if (end) { parts.append(value.slice(end)); node.replaceWith(parts); }
        }
        this._trContent.set(paragraph, { text, frag });
      }
      return frag.cloneNode(true);
    }

    /**
     * Shows the translation in a panel the size of the paragraph, so the original stays readable:
     * on a two-column page beside it in the other column (left column → right, right column → left),
     * otherwise below (above when needed). Match the source width and fit its height
     * with bounded font/leading changes; long translations scroll. Captions size naturally.
     */
    _drawTranslation(ctx, paragraph) {
      const text = this._paragraphTranslation(paragraph);
      if (!text) return false;
      const geom = ctx.geom;
      const metrics = this._lineMetrics(geom, paragraph);
      const pct = this._toPercent(geom, paragraph.bbox);
      const pageH = geom.div.clientHeight || geom.h;
      const gapPct = (4 / pageH) * 100;
      const title = paragraph.paragraphType === "title";
      const box = el(this.pdfDoc, "div", title ? "dr-translation dr-title" : "dr-translation");
      box.style.width = `${pct.width}%`;
      box.style.textIndent = `${metrics.indent}px`;
      box.append(this._translationContent(paragraph, text));
      box.style.visibility = "hidden";
      box.style.top = "0";
      box.style.left = `${pct.left}%`;
      ctx.transient.append(box);

      const visual = ["image", "table", "chart", "figure"].includes(paragraph.paragraphType);
      const rawHeight = (pct.height / 100) * pageH;
      // One-line boxes need space for the border; multiline prose follows its source
      // height. Unmapped legacy figure boxes must never dictate a caption's height.
      const target = Math.max(metrics.lineHeight + 6, rawHeight);
      const ratio = metrics.lineHeight / metrics.fontSize || 1.2;
      const setScale = (k, pitch = ratio) => {
        box.style.fontSize = `${metrics.fontSize * k}px`;
        box.style.lineHeight = `${metrics.fontSize * k * pitch}px`;
      };
      setScale(1);
      if (!visual) {
        box.style.height = `${target}px`;
        const fits = (k, pitch) => {
          setScale(k, pitch);
          return box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1;
        };
        let scale = 1, pitch = ratio;
        if (!fits(1, pitch)) {
          // Tighten leading before shrinking glyphs. Never enlarge short Chinese text
          // merely to fill the English box, nor drop words to make a translation fit.
          pitch = Math.min(ratio, 1.12);
          let lo = Math.max(FIT_MIN, Math.min(1, 9 / metrics.fontSize)), hi = 1;
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) / 2;
            if (fits(mid, pitch)) lo = mid;
            else hi = mid;
          }
          scale = lo;
        }
        setScale(scale, pitch);
        box.dataset.scale = scale.toFixed(2);
      }
      else box.dataset.scale = "1.00";
      box.dataset.overflow = String(box.scrollHeight > box.clientHeight + 1);
      if (box.dataset.overflow === "true") {
        box.tabIndex = 0;
        box.title = DeepRead.bilingual("译文较长，可在框内滚动查看全文", "Scroll inside to read the full translation");
      }
      box.addEventListener("wheel", (event) => { event.stopPropagation(); }, { passive: true });
      box.addEventListener("pointerdown", (event) => event.stopPropagation());
      box.addEventListener("pointerup", (event) => event.stopPropagation());
      box.addEventListener("pointerenter", () => clearTimeout(this._timers.hide));

      let side;
      if (!visual && pct.width <= 60 && this.isTwoColumn(paragraph.pageIndex)) {
        // Mirror into the other column at the same height.
        side = pct.left + pct.width / 2 < 50 ? "right" : "left";
        box.style.left = `${100 - pct.left - pct.width}%`;
        box.style.top = `${pct.top}%`;
      }
      else {
        box.style.left = `${pct.left}%`;
        const height = box.offsetHeight;
        const spaceBelow = pageH * (1 - (pct.top + pct.height + gapPct) / 100);
        const spaceAbove = pageH * ((pct.top - gapPct) / 100);
        if (height > spaceBelow && spaceAbove > spaceBelow) {
          side = "above";
          box.style.top = "";
          box.style.bottom = `${100 - pct.top + gapPct}%`;
        }
        else {
          side = "below";
          box.style.top = `${pct.top + pct.height + gapPct}%`;
        }
      }
      box.dataset.side = side;
      box.dataset.fontSize = parseFloat(box.style.fontSize).toFixed(2);
      box.style.visibility = "";
      // Outline the paragraph the panel belongs to.
      const pad = 2;
      const [x1, y1, x2, y2] = paragraph.bbox;
      this._addRect(ctx.transient, geom, [x1 - pad, y1 - pad, x2 + pad, y2 + pad], "dr-outline");
      return true;
    }

    /* ---------- hover handling ---------- */

    _onKey(event) {
      const alt = event.type === "blur" ? false : !!event.altKey;
      if (alt === this.altDown) return;
      this.altDown = alt;
      if (this.hoverPara) this._drawHover(this.hoverPara);
    }

    _hitTest(event) {
      const pageDiv = event.target?.closest?.(".page[data-page-number]");
      if (!pageDiv) return null;
      const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
      const paragraphs = this.pages.get(pageIndex);
      if (!paragraphs?.length) return null;
      const geom = this._geometry(pageIndex);
      const point = geom && this._clientToPdf(geom, event.clientX, event.clientY);
      if (!point) return null;
      const [x, y] = point;
      for (const paragraph of paragraphs) {
        if (!inRect(paragraph.bbox, x, y, 3)) continue;
        if (paragraph.rects.some((r) => inRect(r, x, y, 3))) return paragraph;
      }
      return null;
    }

    _onPointerMove(event) {
      if (!this.pages.size) return;
      this.altDown = !!event.altKey;
      if (event.target?.closest?.(".dr-translation")) { clearTimeout(this._timers.hide); return; }
      const active = this.options.hoverCards || this.railActive || this.options.translationPopup;
      if (!active || event.buttons) {
        if (this.hoverPara) this._setHover(null);
        return;
      }
      const paragraph = this._hitTest(event);
      if (!paragraph && this.trPara) { this._scheduleHide(); return; }
      if (paragraph) clearTimeout(this._timers.hide);
      if (paragraph !== this._suppressPara) this._suppressPara = null;
      if (paragraph !== this.hoverPara) {
        this._setHover(paragraph);
      }
    }

    _setHover(paragraph) {
      this.hoverPara = paragraph;
      this.trPara = null;
      clearTimeout(this._timers.show);
      clearTimeout(this._timers.translation);
      if (!paragraph) {
        this._clearTransient();
        this.session.rail?.linkParagraph(null);
        this._scheduleHide();
        return;
      }
      clearTimeout(this._timers.hide);
      this._drawHover(paragraph);
      this.session.rail?.linkParagraph(paragraph);
      if (this._translationAllowed(paragraph) && this._paragraphTranslation(paragraph)) {
        this._timers.translation = setTimeout(() => {
          if (this.hoverPara !== paragraph) return;
          this.trPara = paragraph;
          this._drawHover(paragraph);
        }, TRANSLATION_DELAY);
      }
      if (!this.options.hoverCards || this.railActive || this.cardPinned) return;
      this._timers.show = setTimeout(() => this._showCard(paragraph), this.card && !this.card.hidden ? 40 : SHOW_DELAY);
    }

    _scheduleHide() {
      clearTimeout(this._timers.hide);
      this._timers.hide = setTimeout(() => {
        if (this._cardHovered) return;
        this.hoverPara = null;
        this.trPara = null;
        this._clearTransient();
        if (!this.cardPinned) this._hideCard(false);
      }, HIDE_DELAY);
    }

    /* ---------- click: open the paragraph's card ---------- */

    _onPointerDown(event) {
      if (event.target?.closest?.(".dr-translation")) { this._press = null; return; }
      if (!this.pages.size || event.button !== 0) return;
      this._press = { x: event.clientX, y: event.clientY, t: Date.now(), modified: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey };
      // Pressing means working with the original text (select, annotate): show it.
      const paragraph = this._hitTest(event);
      if (paragraph) {
        this._suppressPara = paragraph;
        if (this.trPara === paragraph) {
          this.trPara = null;
          this._drawHover(paragraph);
        }
      }
    }

    _onPointerUp(event) {
      const press = this._press;
      this._press = null;
      if (!press || event.button !== 0 || !this.pages.size) return;
      const paragraph = this._hitTest(event);
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (moved > CLICK_SLOP) {
        // Text selection: keep the original visible under the selection.
        this._suppressPara = paragraph;
        return;
      }
      if (press.modified || Date.now() - press.t > 800) return;
      if (event.target?.closest?.(".annotationLayer a, a[href]")) return;
      this.openParagraph(paragraph, { toggle: true });
    }

    /** Open (or with null: close) the paragraph's card — in the margin rail, or as a pinned hover card. */
    openParagraph(paragraph, { toggle = false } = {}) {
      if (this.railActive && this.session.rail) {
        this.session.rail.openParagraph(paragraph, { toggle });
        return;
      }
      if (toggle && paragraph && this.cardPinned && this.cardPara
          && this.session.groupLead(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`)
            === this.session.groupLead(`p_${this.cardPara.pageIndex}_${this.cardPara.paragraphIndex}`)) {
        this.cardPinned = false;
        this._hideCard(true);
        clearTimeout(this._timers.show);
        return;
      }
      if (!paragraph) {
        if (this.cardPinned) {
          this.cardPinned = false;
          this._hideCard(false);
        }
        return;
      }
      this.cardPinned = false;
      this.hoverPara = paragraph;
      this._showCard(paragraph);
      this.cardPinned = true;
      const key = this.session.groupLead(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`);
      if (DeepRead.prefs.get("cards.autoExplain") !== false && !this.session.explanation(key)
          && DeepRead.Explainer?.eligible(paragraph) && DeepRead.LLM.isConfigured()) {
        const refresh = () => {
          if (!this.cardPinned || this.cardPara !== paragraph) return;
          this.hoverPara = paragraph;
          this._showCard(paragraph);
        };
        const promise = this.session.explainParagraph(key);
        refresh(); // shows "generating…"
        promise.then(refresh, (e) => DeepRead.log("explain on open failed", String(e)));
      }
    }

    /* ---------- card ---------- */

    _ensureCard() {
      if (this.card && this.card.isConnected) return this.card;
      const card = el(this.readerDoc, "div", "deepread-card");
      card.hidden = true;
      card.addEventListener("pointerenter", () => {
        this._cardHovered = true;
        clearTimeout(this._timers.hide);
      });
      card.addEventListener("pointerleave", () => {
        this._cardHovered = false;
        if (this.cardPara) this._drawHover(this.cardPara);
        this._scheduleHide();
      });
      (this.readerDoc.body || this.readerDoc.documentElement).append(card);
      this.card = card;
      return card;
    }

    _hideCard(immediate) {
      clearTimeout(this._timers.show);
      if (immediate) {
        this._cardHovered = false;
        this.cardPinned = false;
      }
      if (this.card) this.card.hidden = true;
      this.cardPara = null;
    }

    _showCard(paragraph) {
      if (!this.attached || paragraph !== this.hoverPara) return;
      const doc = this.readerDoc;
      const card = this._ensureCard();
      this.cardPara = paragraph;
      const showTranslation = this.options.translationPopup;
      card.replaceChildren();

      const head = el(doc, "div", "dr-head");
      head.append(el(doc, "div", "dr-summary", this.session.paragraphSummary(paragraph) || ""));
      const actions = el(doc, "div", "dr-actions");
      const button = (label, title, onClick) => {
        const b = el(doc, "button", "", label);
        b.title = title;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
        actions.append(b);
      };
      button("⧉", DeepRead.t("card.copySummary"), () => {
        const lines = [this.session.paragraphSummary(paragraph), ...(paragraph.points || []).map((p) => `- ${p.summary}`)];
        DeepRead.util.copyToClipboard(lines.filter(Boolean).join("\n"));
      });
      if (this._paragraphTranslation(paragraph)) {
        button("译", DeepRead.t("card.copyTranslation"), () => {
          DeepRead.util.copyToClipboard(this._paragraphTranslation(paragraph));
        });
      }

      button("AI", DeepRead.t("card.askAI"), () => {
        this.session.askAI({ text: paragraph.paragraphText || "", pageIndex: paragraph.pageIndex, block: DeepRead.Rail.blockLabel(paragraph) });
      });
      head.append(actions);
      card.append(head);
      card.style.setProperty("--dr-card-font", `${DeepRead.Rail.clampFont(DeepRead.prefs.number("view.cardFontSize", 12)) + 1}px`);

      // Body: the AI's explanation; the translation is a folded part.
      // A paragraph merged into a card shows that card's explanation.
      const key = this.session.groupLead(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`);
      const explanation = this.session.explanation?.(key);
      if (explanation) {
        const body = el(doc, "div", "dr-explain");
        body.append(DeepRead.Markdown.render(doc, explanation));
        card.append(body);
      }
      else if (this.session.isExplaining?.(key)) {
        card.append(el(doc, "div", "dr-explain dr-explain-pending", DeepRead.bilingual("AI 讲解生成中…", "Writing the explanation…")));
      }

      const list = el(doc, "ol");
      for (const point of paragraph.points || []) {
        const li = el(doc, "li");
        li.dataset.pointId = point.id;
        const paint = () => {
          const level = this.session.pointLevel(point);
          li.dataset.level = String(level);
          const color = this.session.levelColor(level);
          li.classList.toggle("dr-hl", !!color);
          if (color) li.style.setProperty("--dr-hl", color);
        };
        paint();
        li.title = DeepRead.t("card.importance");
        li.append(el(doc, "div", "dr-point-summary", point.summary || ""));
        li.addEventListener("pointerenter", () => this._drawHover(paragraph, point.id));
        li.addEventListener("pointerleave", () => this._drawHover(paragraph));
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          this.session.setPointImportance(point.id, this.session.nextPointLevel(point));
          paint();
        });
        list.append(li);
      }
      if (list.childNodes.length) card.append(list);
      const translation = this._paragraphTranslation(paragraph);
      if (translation) {
        let open = DeepRead.prefs.get("cards.translationOpen") === true;
        const toggle = el(doc, "span", "dr-trtoggle");
        const body = el(doc, "div", "dr-trbody");
        body.append(inlineMarkdown(doc, translation));
        const sync = () => {
          toggle.textContent = `${open ? "▾" : "▸"} ${DeepRead.bilingual("译文", "Translation")}`;
          body.hidden = !open;
        };
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          open = !open;
          sync();
        });
        sync();
        card.append(toggle, body);
      }
      const note = this.session.paragraphNote?.(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`);
      if (note) {
        const block = el(doc, "div", "dr-hnote");
        block.append(el(doc, "div", "dr-hnote-label", DeepRead.bilingual("我的理解", "My understanding")), el(doc, "div", "", note));
        card.append(block);
      }
      const foot = showTranslation && translation ? ` · ${DeepRead.bilingual("按住 Alt 隐藏悬停译文", "hold Alt to hide the hover translation")}` : "";
      card.append(el(doc, "div", "dr-foot", `p. ${paragraph.pageIndex + 1}${foot}`));

      card.hidden = false;
      this._positionCard(card, paragraph);
    }

    _positionCard(card, paragraph) {
      const r = this._rectInReaderDoc(paragraph.pageIndex, paragraph.bbox);
      if (!r) return;
      const width = card.offsetWidth || 340;
      const gap = 12;
      let left;
      if (r.pageRight + gap + width <= r.frameRight - 4) left = r.pageRight + gap;
      else if (r.pageLeft - gap - width >= r.frameLeft + 4) left = r.pageLeft - gap - width;
      else if (r.right + gap + width <= r.frameRight - 4) left = r.right + gap;
      else left = Math.max(r.frameLeft + 4, r.frameRight - width - 8);
      const height = card.offsetHeight || 200;
      let top = Math.max(r.frameTop + 6, Math.min(r.top, r.frameBottom - height - 6));
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    /** Briefly highlight a paragraph after navigation. */
    flash(paragraph) {
      if (!paragraph?.bbox && paragraph?.rects) paragraph = { ...paragraph, bbox: unionRect(paragraph.rects) };
      if (!paragraph?.bbox) return;
      this.hoverPara = null;
      setTimeout(() => {
        this._drawHover(paragraph);
        clearTimeout(this._timers.flash);
        this._timers.flash = setTimeout(() => {
          if (!this.hoverPara) this._clearTransient();
        }, 1600);
      }, 350);
    }

    _injectStyle(doc, id, cssText) {
      if (!doc || doc.getElementById(id)) return;
      const style = doc.createElementNS(HTML_NS, "style");
      style.id = id;
      style.textContent = cssText;
      (doc.head || doc.documentElement).append(style);
      this._cleanup.push(() => style.remove());
    }
  };

  DeepRead.Overlay.unionRect = unionRect;
  DeepRead.Overlay.inlineMarkdown = inlineMarkdown;
})();

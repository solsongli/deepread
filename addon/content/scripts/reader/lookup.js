/*
 * Hover lookup (module "lookup"): rest the pointer on a citation ("[18]", "(Ho et al., 2020)"), a figure or
 * table reference ("Fig. 3", "Table 1"), and a small popover
 * explains it. Independent of the margin cards. Text under the pointer comes from the reader's structured
 * text layer (pdfDocument.getPageData → chars with PDF rects), so it works whatever parser was used.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DWELL = 280; // ms the pointer rests on a token before the popover opens
  const HIDE_DELAY = 260;
  const FIGURE_REF_RE = /(?<![A-Za-z])(Fig(?:ure)?s?\.?|Tables?|Tab\.)\s*(\d+|[IVX]+)(?:\s*\(?([a-z])\)?(?![A-Za-z]))?/gi;

  const CSS = `
.deepread-lookup { position: fixed; z-index: 2147483001; width: 320px; max-height: 60vh; overflow: auto; box-sizing: border-box;
  padding: 9px 11px; border-radius: 9px; background: #fff; color: #1f2328; border: 1px solid rgba(0,0,0,0.12);
  box-shadow: 0 10px 28px rgba(15,23,42,0.18); font: 12.5px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-lookup .dr-lk-kind { display: inline-block; margin-bottom: 4px; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 700; }
.deepread-lookup .dr-lk-kind.dr-cite { background: #e0ecff; color: #1e40af; }
.deepread-lookup .dr-lk-kind.dr-fig { background: #fcf1dc; color: #92400e; }
.deepread-lookup .dr-lk-kind.dr-tab { background: #e4f4f1; color: #115e59; }
.deepread-lookup .dr-lk-kind.dr-term { background: #ede9fe; color: #5b21b6; }
.deepread-lookup .dr-lk-kind.dr-sym { background: #fce7f3; color: #9d174d; }
.deepread-lookup .dr-lk-title { font-weight: 700; margin-bottom: 2px; }
.deepread-lookup .dr-lk-meta { color: #57606a; font-size: 11.5px; }
.deepread-lookup .dr-lk-text { margin-top: 4px; overflow-wrap: anywhere; }
.deepread-lookup .dr-lk-ref { margin-top: 4px; font-size: 11.5px; color: #424a53; overflow-wrap: anywhere; }
.deepread-lookup .dr-lk-lib { margin-top: 6px; padding: 4px 7px; border-radius: 6px; background: #ecfdf3; color: #166534; font-size: 11.5px; }
.deepread-lookup .dr-lk-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.deepread-lookup .dr-lk-actions button { border: 1px solid rgba(0,0,0,0.15); border-radius: 5px; background: #fff; color: inherit;
  font: inherit; font-size: 11.5px; padding: 1px 8px; cursor: pointer; }
.deepread-lookup .dr-lk-actions button:hover { background: #f3f4f6; }
.deepread-lookup canvas { display: block; margin-top: 6px; border-radius: 4px; background: #f4f4f1; }
.deepread-lookup ol { margin: 5px 0 0; padding-inline-start: 1.3em; }
:root[data-color-scheme="dark"] .deepread-lookup { background: #2a2d32; color: #e6e6e6; border-color: rgba(255,255,255,0.14); }
:root[data-color-scheme="dark"] .deepread-lookup .dr-lk-meta, :root[data-color-scheme="dark"] .deepread-lookup .dr-lk-ref { color: #b8bec6; }
:root[data-color-scheme="dark"] .deepread-lookup .dr-lk-actions button { background: #33373d; border-color: rgba(255,255,255,0.15); }
`;

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function charRect(c) {
    const r = c.rect;
    if (!r) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  DeepRead.Lookup = class Lookup {
    constructor(session) {
      this.session = session;
      this._chars = new Map(); // pageIndex → Promise<chars>
      this._cleanup = [];
      this._timers = {};
      this.current = null; // { kind, pageIndex, rect, … }
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "lookup") && this.session.hasResults;
    }

    get overlay() {
      return this.session.overlay;
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.pdfWin = view._iframeWindow;
      this.pdfDoc = this.pdfWin.document;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      const move = (e) => this._onMove(e);
      const down = () => this.hide(true);
      this.pdfWin.addEventListener("pointermove", move, { passive: true });
      this.pdfWin.addEventListener("pointerdown", down, true);
      const viewer = this.pdfDoc.getElementById("viewerContainer");
      viewer?.addEventListener("scroll", down, { passive: true });
      this._cleanup.push(() => {
        this.pdfWin.removeEventListener("pointermove", move);
        this.pdfWin.removeEventListener("pointerdown", down, true);
        viewer?.removeEventListener("scroll", down);
      });
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      for (const t of Object.values(this._timers)) clearTimeout(t);
      this.popover?.remove();
      this.popover = null;
      this.current = null;
    }

    /* ---------- pointer ---------- */

    _onMove(event) {
      if (!this.enabled || event.buttons || event.altKey || event.ctrlKey || event.metaKey) return;
      const { clientX, clientY } = event;
      const pageDiv = event.target?.closest?.(".page[data-page-number]");
      // Still on the token we are showing: keep it.
      if (this.current && pageDiv && this._onToken(this.current, clientX, clientY)) {
        clearTimeout(this._timers.hide);
        return;
      }
      if (this.current) this._scheduleHide();
      clearTimeout(this._timers.probe);
      if (!pageDiv) return;
      const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
      this._timers.probe = setTimeout(() => {
        this.probe(pageIndex, clientX, clientY).catch((e) => DeepRead.log("lookup failed", String(e)));
      }, DWELL);
    }

    _onToken(current, clientX, clientY) {
      const geom = this.overlay._geometry(current.pageIndex);
      const point = geom && this.overlay._clientToPdf(geom, clientX, clientY);
      if (!point) return false;
      const [x1, y1, x2, y2] = current.rect;
      return point[0] >= x1 - 1 && point[0] <= x2 + 1 && point[1] >= y1 - 1 && point[1] <= y2 + 1;
    }

    _scheduleHide() {
      clearTimeout(this._timers.hide);
      this._timers.hide = setTimeout(() => {
        if (!this._popoverHovered) this.hide(true);
      }, HIDE_DELAY);
    }

    hide() {
      clearTimeout(this._timers.hide);
      if (this.popover) this.popover.hidden = true;
      this.current = null;
    }

    /* ---------- text under the pointer ---------- */

    async _pageChars(pageIndex) {
      if (!this._chars.has(pageIndex)) {
        const win = this.pdfWin;
        const promise = (async () => {
          const data = await this.app.pdfDocument.getPageData(Components.utils.cloneInto({ pageIndex }, win));
          const chars = JSON.parse(win.JSON.stringify(data?.chars || []));
          return chars;
        })();
        this._chars.set(pageIndex, promise);
        promise.catch(() => this._chars.delete(pageIndex));
      }
      return this._chars.get(pageIndex);
    }

    /**
     * The line of text around the char under a PDF point: { text, offset, spans: [[start, end, charIndex]] }
     * where spans map text offsets back to chars (for the popover anchor).
     */
    static lineAt(chars, x, y) {
      let hit = -1;
      for (let i = 0; i < chars.length; i++) {
        const r = charRect(chars[i]);
        if (r && x >= r[0] - 0.5 && x <= r[2] + 0.5 && y >= r[1] - 0.5 && y <= r[3] + 0.5) {
          hit = i;
          break;
        }
      }
      if (hit < 0) return null;
      const r0 = charRect(chars[hit]);
      const cy = (r0[1] + r0[3]) / 2;
      const h = Math.max(1, r0[3] - r0[1]);
      const sameLine = (c) => {
        const r = charRect(c);
        if (!r) return true; // spaces without a box
        return Math.abs((r[1] + r[3]) / 2 - cy) < h * 0.7;
      };
      let a = hit;
      while (a > 0 && hit - a < 400 && sameLine(chars[a - 1]) && !chars[a - 1].lineBreakAfter && !chars[a - 1].paragraphBreakAfter) a--;
      let b = hit;
      while (b < chars.length - 1 && b - hit < 400 && sameLine(chars[b + 1]) && !chars[b].lineBreakAfter && !chars[b].paragraphBreakAfter) b++;
      let text = "";
      let offset = 0;
      const spans = [];
      for (let i = a; i <= b; i++) {
        const u = chars[i].u ?? chars[i].c ?? "";
        if (i === hit) offset = text.length;
        spans.push([text.length, text.length + u.length, i]);
        text += u;
        if (chars[i].spaceAfter) text += " ";
      }
      return { text, offset, spans };
    }

    /** PDF rect covering text offsets [start, end) of a line. */
    static spanRect(chars, line, start, end) {
      let rect = null;
      for (const [s, e, i] of line.spans) {
        if (e <= start || s >= end) continue;
        const r = charRect(chars[i]);
        if (!r) continue;
        rect = rect ? [Math.min(rect[0], r[0]), Math.min(rect[1], r[1]), Math.max(rect[2], r[2]), Math.max(rect[3], r[3])] : r;
      }
      return rect;
    }

    /** What is under the pointer? → shows the popover, or hides it. Returns the found item (tests). */
    async probe(pageIndex, clientX, clientY) {
      if (!this.enabled) return null;
      const geom = this.overlay._geometry(pageIndex);
      const point = geom && this.overlay._clientToPdf(geom, clientX, clientY);
      if (!point) return null;
      const chars = await this._pageChars(pageIndex);
      const line = DeepRead.Lookup.lineAt(chars, point[0], point[1]);
      const found = line ? this.find(line.text, line.offset) : null;
      if (!found) {
        if (this.current) this._scheduleHide();
        return null;
      }
      const rect = DeepRead.Lookup.spanRect(chars, line, found.start, found.end) || charRect(chars[line.spans[0][2]]);
      if (this.current && this.current.key === found.key && this.current.pageIndex === pageIndex) return found;
      this.current = { ...found, pageIndex, rect };
      this.show(this.current);
      return found;
    }

    /** Classify the text at `offset` of a line: citation, figure/table reference, term or symbol. */
    find(text, offset) {
      const session = this.session;
      // 1) citation
      const refs = session.references();
      if (refs.list.length && DeepRead.References) {
        const at = DeepRead.References.citationAt(text, offset);
        if (at) {
          const items = at.item ? [at.item] : at.group.items;
          const resolved = items.map((item) => DeepRead.References.resolve(item, refs.list)).filter(Boolean);
          if (resolved.length) {
            return { kind: "citation", key: `c:${resolved.map((r) => r.id).join(",")}`, refs: resolved, start: at.group.start, end: at.group.end };
          }
        }
      }
      // 2) figure / table reference
      FIGURE_REF_RE.lastIndex = 0;
      for (const m of text.matchAll(FIGURE_REF_RE)) {
        if (offset < m.index || offset > m.index + m[0].length) continue;
        const kind = /^t/i.test(m[1]) ? "table" : "figure";
        const figure = session.figures().find((f) => f.kind === kind && String(f.number).toUpperCase() === m[2].toUpperCase());
        if (figure) return { kind: "figure", key: `g:${figure.id}`, figure, panel: m[3] || null, start: m.index, end: m.index + m[0].length };
      }
      return null;
    }

    /* ---------- popover ---------- */

    _ensurePopover() {
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-lookup-css")) {
        const style = el(doc, "style");
        style.id = "deepread-lookup-css";
        style.textContent = CSS;
        (doc.head || doc.documentElement).append(style);
        this._cleanup.push(() => doc.getElementById("deepread-lookup-css")?.remove());
      }
      if (this.popover?.isConnected) return this.popover;
      const pop = el(doc, "div", "deepread-lookup");
      pop.hidden = true;
      pop.addEventListener("pointerenter", () => {
        this._popoverHovered = true;
        clearTimeout(this._timers.hide);
      });
      pop.addEventListener("pointerleave", () => {
        this._popoverHovered = false;
        this._scheduleHide();
      });
      (doc.body || doc.documentElement).append(pop);
      this.popover = pop;
      this._cleanup.push(() => pop.remove());
      return pop;
    }

    show(item) {
      const pop = this._ensurePopover();
      pop.replaceChildren();
      pop.dataset.kind = item.kind;
      if (item.kind === "citation") this._fillCitation(pop, item);
      else if (item.kind === "figure") this._fillFigure(pop, item);

      pop.hidden = false;
      this._position(pop, item);
    }

    _position(pop, item) {
      const r = this.overlay._rectInReaderDoc(item.pageIndex, item.rect);
      if (!r) return;
      const width = pop.offsetWidth || 320;
      const height = pop.offsetHeight || 160;
      let left = Math.min(Math.max(r.frameLeft + 4, r.left - 20), r.frameRight - width - 6);
      let top = r.bottom + 6;
      if (top + height > r.frameBottom - 4) top = Math.max(r.frameTop + 4, r.top - height - 6);
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    }

    _actions(pop, list) {
      const box = el(this.readerDoc, "div", "dr-lk-actions");
      for (const [label, fn] of list) {
        const b = el(this.readerDoc, "button", "", label);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        box.append(b);
      }
      pop.append(box);
    }

    _fillCitation(pop, item) {
      const doc = this.readerDoc;
      const occurrences = this.session.references().occurrences;
      for (const ref of item.refs.slice(0, 3)) {
        pop.append(el(doc, "span", "dr-lk-kind dr-cite", DeepRead.bilingual(`参考文献 ${ref.label}`, `Reference ${ref.label}`)));
        if (ref.title) pop.append(el(doc, "div", "dr-lk-title", ref.title));
        const meta = [ref.authors, ref.year].filter(Boolean).join(" · ");
        if (meta) pop.append(el(doc, "div", "dr-lk-meta", meta));
        if (!ref.title) pop.append(el(doc, "div", "dr-lk-ref", ref.text));
        const count = occurrences.get(ref.id)?.length || 0;
        if (count) pop.append(el(doc, "div", "dr-lk-meta", DeepRead.bilingual(`本文共 ${count} 处引用它`, `Cited ${count} times in this paper`)));
        const lib = el(doc, "div", "dr-lk-lib");
        lib.hidden = true;
        pop.append(lib);
        const actions = [];
        actions.push([DeepRead.bilingual("复制条目", "Copy"), () => DeepRead.util.copyToClipboard(ref.text)]);
        const query = ref.doi ? `https://doi.org/${ref.doi}` : ref.arxiv ? `https://arxiv.org/abs/${ref.arxiv}`
          : `https://scholar.google.com/scholar?q=${encodeURIComponent(ref.title || ref.text.slice(0, 200))}`;
        actions.push([ref.doi ? "DOI" : ref.arxiv ? "arXiv" : DeepRead.bilingual("学术搜索", "Scholar"), () => Zotero.launchURL(query)]);
        this._actions(pop, actions);
        // In the reader's own library? Then offer to open it.
        DeepRead.Lookup.findInLibrary(ref).then((found) => {
          if (!found || !pop.isConnected || this.current?.key !== item.key) return;
          lib.hidden = false;
          lib.textContent = DeepRead.bilingual("✓ 已在你的文库中", "✓ In your library");
          const open = el(doc, "button", "", DeepRead.bilingual("打开", "Open"));
          open.style.marginInlineStart = "8px";
          open.addEventListener("click", (e) => {
            e.stopPropagation();
            DeepRead.Lookup.openItem(found);
          });
          lib.append(open);
        }).catch(() => {});
      }
    }

    _fillFigure(pop, item) {
      const doc = this.readerDoc;
      const figure = item.figure;
      const table = figure.kind === "table";
      pop.append(el(doc, "span", `dr-lk-kind ${table ? "dr-tab" : "dr-fig"}`, DeepRead.Rail.figureLabel(figure)));
      const guide = this.session.figureGuide(figure.id);
      pop.append(el(doc, "div", "dr-lk-title", guide?.title || figure.title || ""));
      if (!figure.captionOnly && figure.bbox) {
        const canvas = el(doc, "canvas");
        pop.append(canvas);
        this._drawThumb(canvas, figure);
      }
      if (guide?.steps?.length) {
        const list = el(doc, "ol");
        const steps = item.panel ? guide.steps.filter((s) => !s.panel || s.panel === item.panel) : guide.steps;
        for (const step of (steps.length ? steps : guide.steps).slice(0, 3)) {
          const li = el(doc, "li");
          li.append(DeepRead.Overlay.inlineMarkdown(doc, step.text || ""));
          list.append(li);
        }
        pop.append(list);
      }
      else if (figure.caption) {
        pop.append(el(doc, "div", "dr-lk-ref", figure.caption.length > 220 ? `${figure.caption.slice(0, 220)}…` : figure.caption));
      }
      this._actions(pop, [[DeepRead.bilingual("跳到图表", "Go to it"), () => {
        const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
        this.session.reader.navigate(rect ? { position: { pageIndex: figure.pageIndex, rects: [rect] } } : { pageIndex: figure.pageIndex });
        this.hide();
      }]]);
    }



    _drawThumb(canvas, figure) {
      const [x1, y1, x2, y2] = figure.bbox;
      const width = 296;
      const height = Math.min(170, Math.round(width * Math.max(0.15, (y2 - y1) / Math.max(1, x2 - x1))));
      const ratio = this.readerWin?.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      try {
        const source = this.app?.pdfViewer?.getPageView(figure.pageIndex)?.div?.querySelector("canvas");
        if (!source || !source.width) return;
        const src = Components.utils.unwaiveXrays ? Components.utils.unwaiveXrays(source) : source;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(src, (x1 / 1000) * source.width, (y1 / 1000) * source.height,
          ((x2 - x1) / 1000) * source.width, ((y2 - y1) / 1000) * source.height, 0, 0, canvas.width, canvas.height);
        canvas.dataset.drawn = "1";
      }
      catch (e) {
        DeepRead.log("lookup thumbnail failed", String(e));
      }
    }

    /* ---------- library ---------- */

    /** A regular item in the user's library matching the reference (DOI, else title), or null. */
    static async findInLibrary(ref) {
      const cache = (DeepRead.Lookup._libCache = DeepRead.Lookup._libCache || new Map());
      const cacheKey = ref.doi || ref.title;
      if (!cacheKey) return null;
      if (cache.has(cacheKey)) return cache.get(cacheKey);
      const search = async (field, value) => {
        const s = new Zotero.Search();
        s.libraryID = Zotero.Libraries.userLibraryID;
        s.addCondition(field, "contains", value);
        s.addCondition("itemType", "isNot", "attachment");
        s.addCondition("itemType", "isNot", "note");
        const ids = await s.search();
        return ids.length ? Zotero.Items.get(ids) : [];
      };
      const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      let found = null;
      try {
        if (ref.doi) found = (await search("DOI", ref.doi))[0] || null;
        if (!found && ref.title && ref.title.length >= 12) {
          const items = await search("title", ref.title.slice(0, 60));
          found = items.find((i) => norm(i.getField("title")) === norm(ref.title)) || items[0] || null;
        }
      }
      catch (e) {
        DeepRead.log("library lookup failed", String(e));
      }
      cache.set(cacheKey, found);
      return found;
    }

    static async openItem(item) {
      const attachment = await item.getBestAttachment?.();
      if (attachment) await Zotero.Reader.open(attachment.id);
      else Zotero.getMainWindow()?.ZoteroPane?.selectItem(item.id);
    }
  };
})();

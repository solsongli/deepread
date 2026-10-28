/*
 * Section bar (module "structureBar"): a thin strip under the reader toolbar showing the paper's
 * top-level sections (DeepRead.Structure), sized by length and coloured by role, with how far the
 * reader has got and where they are now. Clicking a section jumps to it.
 * The same strip carries the skim controls (module "skim": reading depth, reading time, next key
 * paragraph) and the reading questions' markers (module "questions").
 *
 * The reader UI positions #split-view at top: 41px (below its toolbar); the bar takes that slot and
 * pushes the views down by its height.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const TOOLBAR = 41;
  const HEIGHT = 30;

  // [read, unread, text on read, text on unread]
  const COLORS = {
    front: ["#59647a", "#cdd3de", "#fff", "#3a3f4c"],
    intro: ["#59647a", "#cdd3de", "#fff", "#3a3f4c"],
    background: ["#7c8597", "#dce0e7", "#fff", "#3a3f4c"],
    method: ["#2b59c3", "#c7d3f0", "#fff", "#1e428f"],
    experiment: ["#0f766e", "#bfe0dc", "#fff", "#0b5550"],
    discussion: ["#6b6b66", "#dcdcd8", "#fff", "#3a3a36"],
    references: ["#a9a9a4", "#ececE8", "#1d1d1b", "#5c5c57"],
    appendix: ["#a9a9a4", "#ececE8", "#1d1d1b", "#5c5c57"],
  };

  const CSS = `
body.deepread-has-bar #split-view { top: ${TOOLBAR + HEIGHT}px !important; }
#deepread-bar { position: absolute; top: ${TOOLBAR}px; inset-inline-start: 0; inset-inline-end: 0; height: ${HEIGHT}px; z-index: 3;
  box-sizing: border-box; padding: 5px 10px; display: flex; align-items: center; gap: 10px;
  background: var(--material-toolbar, #f6f6f4); border-bottom: 1px solid var(--color-panedivider, rgba(0,0,0,0.12));
  font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
body.sidebar-open #deepread-bar { inset-inline-start: var(--sidebar-width); }
#deepread-bar .dr-segs { position: relative; flex: 1; min-width: 0; display: flex; gap: 2px; height: 20px; }
#deepread-bar .dr-seg { position: relative; min-width: 10px; border: none; margin: 0; padding: 0 6px; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; text-align: start; font: inherit; font-weight: 500; line-height: 20px; cursor: pointer; }
#deepread-bar .dr-seg:first-child { border-start-start-radius: 4px; border-end-start-radius: 4px; }
#deepread-bar .dr-seg:last-child { border-start-end-radius: 4px; border-end-end-radius: 4px; }
#deepread-bar .dr-seg.dr-current { box-shadow: inset 0 0 0 1.5px #1d1d1b; }
#deepread-bar .dr-seg:hover { filter: brightness(0.96); }
#deepread-bar .dr-here { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-inline-start: -1px; border-radius: 1px;
  background: #1d1d1b; pointer-events: none; transition: inset-inline-start .15s; }
#deepread-bar .dr-read { flex-shrink: 0; color: var(--fill-secondary, #4a4a46); white-space: nowrap; }
#deepread-bar .dr-spacer { flex: 1; }
#deepread-bar .dr-depth { flex-shrink: 0; display: flex; padding: 2px; border-radius: 6px; background: rgba(0,0,0,0.06); }
#deepread-bar .dr-depth button { border: none; margin: 0; padding: 2px 8px; border-radius: 4px; background: transparent; color: inherit;
  font: inherit; cursor: pointer; opacity: 0.7; }
#deepread-bar .dr-depth button[aria-pressed="true"] { background: var(--material-background, #fff); opacity: 1; font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
#deepread-bar .dr-skimtime { flex-shrink: 0; color: var(--fill-secondary, #4a4a46); white-space: nowrap; }
#deepread-bar .dr-nextkey { flex-shrink: 0; border: 1px solid rgba(217,119,6,0.5); border-radius: 5px; padding: 1px 7px; background: #fff7ea;
  color: #92400e; font: inherit; cursor: pointer; white-space: nowrap; }
#deepread-bar .dr-figures { max-width: 100px; min-width: 60px; font: inherit; color: inherit; }
@media (max-width: 1000px) { #deepread-bar .dr-skimtime { display: none; } }
#deepread-bar .dr-nextkey:hover { background: #fdecc8; }
#deepread-bar .dr-qmark { position: absolute; top: -5px; height: 12px; min-width: 16px; margin-inline-start: -8px; padding: 0 3px; box-sizing: border-box;
  border-radius: 6px; border: 1px solid #7c3aed; background: #fff; color: #5b21b6; font-size: 8.5px; font-weight: 700; line-height: 10px;
  text-align: center; cursor: pointer; z-index: 2; }
#deepread-bar .dr-qmark.dr-reached { background: #7c3aed; color: #fff; }
:root[data-color-scheme="dark"] #deepread-bar .dr-depth { background: rgba(255,255,255,0.08); }
:root[data-color-scheme="dark"] #deepread-bar .dr-nextkey { background: rgba(217,119,6,0.15); color: #fbbf24; }
:root[data-color-scheme="dark"] #deepread-bar .dr-here { background: #f2f2f2; }
:root[data-color-scheme="dark"] #deepread-bar .dr-seg.dr-current { box-shadow: inset 0 0 0 1.5px #f2f2f2; }
`;

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.StructureBar = class StructureBar {
    constructor(session) {
      this.session = session;
      this.root = null;
      this.sections = [];
      this._cleanup = [];
      this._raf = null;
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "structureBar");
    }

    get skim() {
      return DeepRead.Modules.enabled(this.session, "skim") && this.session.hasResults;
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.pdfWin = view._iframeWindow;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      const container = this.pdfWin.document.getElementById("viewerContainer");
      const onScroll = () => this.schedule();
      container?.addEventListener("scroll", onScroll, { passive: true });
      this._cleanup.push(() => container?.removeEventListener("scroll", onScroll));
      // N / Shift+N: next / previous key paragraph (skim layers).
      const onKey = (event) => {
        if (event.key !== "n" && event.key !== "N") return;
        if (event.ctrlKey || event.metaKey || event.altKey || !this.skim) return;
        const target = event.target;
        if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName || "")) return;
        event.preventDefault();
        this.goKey(event.shiftKey ? -1 : 1);
      };
      this.pdfWin.addEventListener("keydown", onKey, true);
      this._cleanup.push(() => this.pdfWin.removeEventListener("keydown", onKey, true));
      const onPages = Components.utils.exportFunction(() => this.schedule(), this.pdfWin);
      try {
        this.app.eventBus.on("pagesloaded", onPages);
        this.app.eventBus.on("scalechanging", onPages);
      }
      catch (e) {}
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagesloaded", onPages);
          this.app.eventBus.off("scalechanging", onPages);
        }
        catch (e) {}
      });
      this.attached = true;
      this.refresh();
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      if (this._raf && this.readerWin) this.readerWin.cancelAnimationFrame(this._raf);
      this._raf = null;
      this._remove();
      this.attached = false;
    }

    _remove() {
      this.root?.remove();
      this.root = null;
      this.readerDoc?.body?.classList.remove("deepread-has-bar");
    }

    /** Rebuild from the session's content list (call after results or module switches change). */
    refresh() {
      if (!this.attached) return;
      const contentList = this.session.data?.contentList;
      this.sections = this.enabled && Array.isArray(contentList) ? DeepRead.Structure.sections(contentList) : [];
      if (this.sections.length < 2) this.sections = [];
      if (!this.sections.length && !this.skim) {
        this._remove();
        return;
      }
      this._build();
      this.schedule();
    }

    _build() {
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-bar-css")) {
        const style = el(doc, "style");
        style.id = "deepread-bar-css";
        style.textContent = CSS;
        (doc.head || doc.documentElement).append(style);
        this._cleanup.push(() => doc.getElementById("deepread-bar-css")?.remove());
      }
      this._remove();
      const root = el(doc, "div");
      root.id = "deepread-bar";
      root.setAttribute("role", "navigation");
      root.setAttribute("aria-label", DeepRead.bilingual("全文结构", "Paper structure"));
      const segs = el(doc, "div", this.sections.length ? "dr-segs" : "dr-spacer");
      this.total = Math.max(1, ...this.sections.map((s) => s.end));
      this.segs = this.sections.map((section) => {
        const button = el(doc, "button", "dr-seg", section.label);
        button.style.flex = `${Math.max(0.15, section.end - section.start)} 1 0`;
        const pages = `p.${Math.floor(section.start) + 1}–${Math.max(Math.floor(section.start) + 1, Math.ceil(section.end))}`;
        button.title = `${section.label} · ${pages}`;
        button.addEventListener("click", () => this._goTo(section));
        segs.append(button);
        return button;
      });
      this.here = el(doc, "span", "dr-here");
      if (this.sections.length) segs.append(this.here);
      // Reading questions: one marker per question, at its answer, on the section it falls in.
      this.qmarks = [];
      if (this.sections.length && DeepRead.Modules.enabled(this.session, "questions")) {
        for (const q of this.session.questions?.items || []) {
          const positions = (q.keys || []).map((k) => this.session.keyPosition(k)).filter((p) => p !== null);
          if (!positions.length) continue;
          const mark = el(doc, "span", "dr-qmark", this.session.questionLabel(q));
          mark.title = q.question;
          mark.addEventListener("click", (e) => {
            e.stopPropagation();
            const [page, para] = String(q.keys[0]).replace(/^p_/, "").split("_").map(Number);
            this.session.openBlock(page, para);
            DeepRead.Panes?.reveal(this.session.reader, "questions");
          });
          segs.append(mark);
          this.qmarks.push({ mark, q, at: Math.min(...positions) });
        }
      }
      root.append(segs);
      this.depth = null;
      if (this.skim) {
        const depth = el(doc, "div", "dr-depth");
        depth.setAttribute("role", "group");
        depth.setAttribute("aria-label", DeepRead.bilingual("阅读深度", "Reading depth"));
        const modes = [["full", "全文", "Full"], ["key", "重点", "Key"], ["margin", "只看边注", "Margin only"]];
        for (const [mode, zh, en] of modes) {
          const button = el(doc, "button", "", DeepRead.bilingual(zh, en));
          button.dataset.mode = mode;
          button.setAttribute("aria-pressed", String(this.session.skimDepth === mode));
          button.title = {
            full: DeepRead.bilingual("正常显示全文", "Show everything"),
            key: DeepRead.bilingual("淡化次要段落、标出关键句，次要卡片收成一行", "Fade minor paragraphs, mark key sentences, fold minor cards"),
            margin: DeepRead.bilingual("淡化正文，只读页边卡片的一句话摘要", "Fade the text; read the cards' one-line summaries"),
          }[mode];
          button.addEventListener("click", () => this.session.setSkimDepth(mode));
          depth.append(button);
        }
        this.timeLabel = el(doc, "span", "dr-skimtime");
        const next = el(doc, "button", "dr-nextkey", DeepRead.bilingual("下一个重点 ↓", "Next key ↓"));
        next.title = DeepRead.bilingual("跳到下一个重点段落（快捷键 N，Shift+N 上一个）", "Jump to the next key paragraph (N; Shift+N for the previous one)");
        next.addEventListener("click", () => this.goKey(1));
        root.append(depth, this.timeLabel, next);
        this.depth = depth;
        const figures = this.session.figures();
        if (figures.length) {
          const select = el(doc, "select", "dr-figures");
          select.setAttribute("aria-label", DeepRead.bilingual("按图表阅读", "Read by figure"));
          select.title = DeepRead.bilingual("先看图注与证据，再返回正文核对解释", "Read captions and evidence, then check the claims in the text");
          const hint = el(doc, "option", "", DeepRead.bilingual("读图…", "Figures…"));
          hint.value = "";
          select.append(hint);
          figures.forEach((figure, i) => {
            const option = el(doc, "option", "", `${figure.label || figure.number || i + 1} · p.${figure.pageIndex + 1} · ${figure.title || figure.caption || ""}`.slice(0, 100));
            option.value = String(i);
            select.append(option);
          });
          select.addEventListener("change", () => {
            if (select.value === "") return;
            const figure = figures[Number(select.value)];
            const rect = this.session.overlay?.permilleRect(figure.pageIndex, figure.bbox);
            this.session.reader.navigate(rect ? { position: { pageIndex: figure.pageIndex, rects: [rect] } } : { pageIndex: figure.pageIndex });
            select.value = "";
          });
          root.append(select);
        }
      }
      this.readLabel = el(doc, "span", "dr-read");
      root.append(this.readLabel);
      doc.body.append(root);
      doc.body.classList.add("deepread-has-bar");
      this.root = root;
      this.segBox = segs;
    }

    /** Jump to the section heading itself (sections often start mid-page); reader.navigate would centre it. */
    _goTo(section) {
      const pageIndex = Math.floor(section.start);
      const viewer = this.app?.pdfViewer;
      const container = viewer?.container;
      const div = viewer?.getPageView(pageIndex)?.div;
      if (!container || !div) {
        this.session.reader.navigate({ pageIndex });
        return;
      }
      const page = div.getBoundingClientRect();
      const offset = page.top - container.getBoundingClientRect().top + (section.start - pageIndex) * page.height;
      container.scrollTop = Math.max(0, container.scrollTop + offset - 24);
    }

    /** "本页速读约 40 秒 · 全文约 6 分钟" for the current reading depth. */
    _updateTime(pageIndex) {
      const depth = this.session.skimDepth;
      const mode = depth === "full" ? "full" : depth;
      const { tier } = this.session.skimTiers();
      const all = [];
      let page = [];
      for (const p of this.session.data?.hierarchicalData || []) {
        const paragraphs = (p.paragraphs || []).map((x) => ({ ...x, pageIndex: p.pageIndex }));
        all.push(...paragraphs);
        if (p.pageIndex === pageIndex) page = paragraphs;
      }
      const pageSec = DeepRead.Skim.readingTime(page, { tier, mode });
      const allMin = Math.max(1, Math.round(DeepRead.Skim.readingTime(all, { tier, mode }) / 60));
      const pageText = pageSec < 60 ? DeepRead.bilingual(`${Math.max(5, Math.round(pageSec / 5) * 5)} 秒`, `${Math.max(5, Math.round(pageSec / 5) * 5)} s`)
        : DeepRead.bilingual(`${Math.round(pageSec / 60)} 分钟`, `${Math.round(pageSec / 60)} min`);
      this.timeLabel.textContent = DeepRead.bilingual(`本页约 ${pageText} · 全文约 ${allMin} 分钟`, `This page ~${pageText} · paper ~${allMin} min`);
      for (const button of this.depth?.children || []) button.setAttribute("aria-pressed", String(button.dataset.mode === depth));
    }

    /** Jump to the next (dir 1) or previous (dir −1) key paragraph from the reading line. */
    goKey(dir) {
      const container = this.app?.pdfViewer?.container;
      if (!container || !this.session.hasResults) return false;
      const now = this._positionAt(container.scrollTop + container.clientHeight * 0.2);
      const { tier } = this.session.skimTiers();
      const entries = [];
      for (const page of this.session.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          const key = `p_${page.pageIndex}_${paragraph.paragraphIndex}`;
          if (tier.get(key) !== "key") continue;
          const position = this.session.keyPosition(key);
          if (position !== null) entries.push({ key, pageIndex: page.pageIndex, top: Math.round((position % 1) * 1000), paragraph });
        }
      }
      // A little past the line so the paragraph we just jumped to is not chosen again.
      const from = { pageIndex: Math.floor(now), top: Math.round((now % 1) * 1000) + (dir > 0 ? 15 : -15) };
      const target = dir > 0 ? DeepRead.Skim.nextKey(entries, from) : DeepRead.Skim.prevKey(entries, from);
      if (!target) return false;
      const page = Math.floor(this.session.keyPosition(target.key));
      const div = this.app.pdfViewer.getPageView(page)?.div;
      if (div) {
        const box = div.getBoundingClientRect();
        const offset = box.top - container.getBoundingClientRect().top + (target.top / 1000) * box.height;
        container.scrollTop = Math.max(0, container.scrollTop + offset - container.clientHeight * 0.2 + 12);
      }
      this.session.overlay.flash({ ...target.paragraph, pageIndex: page });
      this.lastKey = target.key;
      return true;
    }

    schedule() {
      // Without the strip, reading progress is still tracked for the reading questions.
      if (this._raf || !this.readerWin || (!this.root && !DeepRead.Modules.enabled(this.session, "questions"))) return;
      this._raf = this.readerWin.requestAnimationFrame(() => {
        this._raf = null;
        try {
          this._update();
        }
        catch (e) {
          DeepRead.log("structure bar update failed", String(e));
        }
      });
    }

    /** Fractional page position (page index + fraction) at a scroll offset of the viewer. */
    _positionAt(offset) {
      const viewer = this.app?.pdfViewer;
      const container = viewer?.container;
      if (!container) return 0;
      const top = container.getBoundingClientRect().top - container.scrollTop;
      const count = viewer.pagesCount || 0;
      for (let i = 0; i < count; i++) {
        const div = viewer.getPageView(i)?.div;
        if (!div) continue;
        const r = div.getBoundingClientRect();
        const start = r.top - top;
        if (offset < start + r.height || i === count - 1) {
          return i + Math.min(1, Math.max(0, (offset - start) / (r.height || 1)));
        }
      }
      return 0;
    }

    _update() {
      const container = this.app?.pdfViewer?.container;
      if (!container) return;
      // Reading line a little below the top edge: jumps land with padding above the heading.
      const now = this._positionAt(container.scrollTop + container.clientHeight * 0.2);
      const seen = this._positionAt(container.scrollTop + container.clientHeight * 0.85);
      const state = this.session.userState;
      if (seen > (state.readUpTo || 0)) {
        state.readUpTo = Math.round(seen * 100) / 100;
        this.session._saveUserStateSoon();
        // Reaching a question's answer updates the toolbar count and the questions section.
        if (this.session.questions?.items?.length) {
          const reached = this.session.questionProgress().reached;
          if (reached !== this._reached) {
            this._reached = reached;
            this.session._emit("questions");
          }
        }
      }
      if (!this.root) return;
      const readUpTo = state.readUpTo || 0;
      this.sections.forEach((section, i) => {
        const [dark, light, onDark, onLight] = COLORS[section.role] || COLORS.method;
        const span = section.end - section.start || 1;
        const read = Math.max(0, Math.min(1, (readUpTo - section.start) / span));
        const pct = Math.round(read * 100);
        const seg = this.segs[i];
        seg.style.background = `linear-gradient(90deg, ${dark} 0 ${pct}%, ${light} ${pct}% 100%)`;
        // The label sits at the start of the segment: light text once the read fill covers its middle.
        const labelMid = Math.min(seg.scrollWidth, seg.offsetWidth) / 2;
        seg.style.color = read * seg.offsetWidth > labelMid ? onDark : onLight;
        seg.classList.toggle("dr-current", now >= section.start && now < section.end);
      });
      // Positions on the strip: inside the section's button (flex sizes are not linear in pages).
      const xOf = (position) => {
        const i = DeepRead.Structure.sectionAt(this.sections, Math.floor(position), (position % 1) * 1000);
        if (i < 0) return null;
        const section = this.sections[i];
        const frac = Math.max(0, Math.min(1, (position - section.start) / (section.end - section.start || 1)));
        return this.segs[i].offsetLeft + frac * this.segs[i].offsetWidth;
      };
      for (const { mark, q, at } of this.qmarks || []) {
        const x = xOf(at);
        mark.hidden = x === null;
        if (x !== null) mark.style.insetInlineStart = `${x}px`;
        mark.classList.toggle("dr-reached", this.session.questionReached(q));
      }
      if (this.timeLabel) this._updateTime(Math.floor(now));
      const index = this.sections.length ? DeepRead.Structure.sectionAt(this.sections, Math.floor(now), (now % 1) * 1000) : -1;
      if (index >= 0) {
        const section = this.sections[index];
        const seg = this.segs[index];
        const frac = Math.max(0, Math.min(1, (now - section.start) / (section.end - section.start || 1)));
        this.here.style.insetInlineStart = `${seg.offsetLeft + frac * seg.offsetWidth}px`;
        this.here.hidden = false;
      }
      else if (this.here) this.here.hidden = true;
      const pages = this.app.pdfViewer.pagesCount || this.total;
      this.readLabel.textContent = DeepRead.bilingual(`已读 ${Math.min(100, Math.round((readUpTo / pages) * 100))}%`,
        `${Math.min(100, Math.round((readUpTo / pages) * 100))}% read`);
    }
  };
})();

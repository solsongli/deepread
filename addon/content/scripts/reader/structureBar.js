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

  // [progress line, label background, label text]
  const COLORS = {
    front: ["#59647a", "#cdd3de", "#3a3f4c"],
    intro: ["#59647a", "#cdd3de", "#3a3f4c"],
    background: ["#7c8597", "#dce0e7", "#3a3f4c"],
    method: ["#2b59c3", "#c7d3f0", "#1e428f"],
    experiment: ["#0f766e", "#bfe0dc", "#0b5550"],
    discussion: ["#6b6b66", "#dcdcd8", "#3a3a36"],
    references: ["#a9a9a4", "#ecece8", "#5c5c57"],
    appendix: ["#a9a9a4", "#ecece8", "#5c5c57"],
  };

  const CSS = `
body.deepread-has-bar #split-view { top: calc(${TOOLBAR}px + var(--deepread-bar-height, 30px)) !important; }
#deepread-bar { position: absolute; top: ${TOOLBAR}px; inset-inline-start: 0; inset-inline-end: 0; min-height: 30px; z-index: 3;
  box-sizing: border-box; padding: 5px 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
  background: var(--dr-surface-soft, #f4f6fa); color: var(--dr-text, #202939); border-bottom: 1px solid var(--dr-border, #d8dee8);
  font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
body.sidebar-open #deepread-bar { inset-inline-start: var(--sidebar-width); }
#deepread-bar .dr-map { display: flex; align-items: center; gap: 8px; flex: 1 1 280px; min-width: 0; }
#deepread-bar .dr-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
#deepread-bar .dr-segs { position: relative; flex: 1; min-width: 0; display: flex; gap: 2px; height: 20px; }
#deepread-bar .dr-seg { position: relative; min-width: 54px; border: none; margin: 0; padding: 0 6px; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; text-align: start; font: inherit; font-weight: 500; line-height: 20px; cursor: pointer; }
#deepread-bar .dr-seg:first-child { border-start-start-radius: 4px; border-end-start-radius: 4px; }
#deepread-bar .dr-seg:last-child { border-start-end-radius: 4px; border-end-end-radius: 4px; }
#deepread-bar .dr-seg.dr-current { box-shadow: inset 0 0 0 1.5px #1d1d1b; }
#deepread-bar .dr-seg:hover { filter: brightness(0.96); }
#deepread-bar .dr-here { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-inline-start: -1px; border-radius: 1px;
  background: #1d1d1b; pointer-events: none; transition: inset-inline-start .15s; }
#deepread-bar .dr-read { flex-shrink: 0; color: var(--dr-muted, #526075); white-space: nowrap; }
#deepread-bar .dr-section-picker { flex: 1; min-width: 0; width: 0; }
#deepread-bar select { height: 22px; padding: 1px 4px; border: 1px solid var(--dr-border, #d8dee8); border-radius: 4px;
  background: var(--dr-surface, #fff); color: inherit; font: inherit; }
#deepread-bar .dr-segs[hidden], #deepread-bar .dr-section-picker[hidden], #deepread-bar .dr-qmark[hidden], #deepread-bar .dr-controls[hidden] { display: none; }
#deepread-bar :is(button, select):focus-visible { outline: 2px solid var(--dr-accent, #2459a9); outline-offset: 2px; }
#deepread-bar .dr-spacer { flex: 1; }
#deepread-bar .dr-depth { flex-shrink: 0; display: flex; padding: 2px; border-radius: 6px; background: rgba(0,0,0,0.06); }
#deepread-bar .dr-depth button { border: none; margin: 0; padding: 2px 8px; border-radius: 4px; background: transparent; color: inherit;
  font: inherit; cursor: pointer; opacity: 0.7; }
#deepread-bar .dr-depth button[aria-pressed="true"] { background: var(--dr-surface, #fff); opacity: 1; font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
#deepread-bar .dr-skimtime { color: var(--dr-muted, #526075); white-space: nowrap; }
#deepread-bar .dr-nextkey { flex-shrink: 0; border: 1px solid var(--dr-border, #d8dee8); border-radius: 5px; padding: 1px 7px; background: var(--dr-accent-soft, #eaf1fc);
  color: var(--dr-accent, #2459a9); font: inherit; cursor: pointer; white-space: nowrap; }
#deepread-bar .dr-figures { max-width: 100px; min-width: 60px; font: inherit; color: inherit; }
#deepread-bar .dr-question-picker { width: 105px; min-width: 0; }
#deepread-bar.dr-compact .dr-skimtime { display: none; }
#deepread-bar .dr-nextkey:hover { background: var(--dr-accent-soft, #eaf1fc); border-color: var(--dr-accent, #2459a9); }
#deepread-bar .dr-qmark { position: absolute; top: -4px; height: 15px; min-width: 20px; padding: 0 3px; box-sizing: border-box;
  border-radius: 5px; border: 1px solid #7c3aed; background: #fff; color: #5b21b6; font-size: 9px; font-weight: 700; line-height: 13px;
  text-align: center; cursor: pointer; z-index: 2; }
#deepread-bar .dr-qmark.dr-reached { background: #7c3aed; color: #fff; }
:root[data-color-scheme="dark"] #deepread-bar .dr-depth { background: rgba(255,255,255,0.08); }
:root[data-color-scheme="dark"] #deepread-bar .dr-nextkey { background: var(--dr-accent-soft, #293e5d); color: var(--dr-accent, #a7c7fa); }
:root[data-color-scheme="dark"] #deepread-bar .dr-qmark { background: #2e2445; color: #e5d5ff; border-color: #aa8adb; }
:root[data-color-scheme="dark"] #deepread-bar .dr-qmark.dr-reached { background: #6d28d9; color: #fff; }
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
      this._buildSignature = null;
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
      const onKey = (event) => this._onKey(event);
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
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
      this.root?.remove();
      this.root = null;
      this.readerDoc?.body?.classList.remove("deepread-has-bar");
      this.readerDoc?.body?.style.removeProperty("--deepread-bar-height");
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
      // Progress and skim updates should not replace a focused button or an open native selector.
      const signature = JSON.stringify({ sections: this.sections, skim: this.skim,
        figures: this.skim ? this.session.figures() : [],
        questions: DeepRead.Modules.enabled(this.session, "questions")
          ? (this.session.questions?.items || []).map((q) => [q.id, q.question, q.keys]) : [] });
      if (!this.root || signature !== this._buildSignature) {
        this._buildSignature = signature;
        this._build();
      }
      this.schedule();
    }

    _build() {
      const doc = this.readerDoc;
      const focusKey = this.root?.contains(doc.activeElement) ? doc.activeElement?.dataset?.focusKey : null;
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
      const map = el(doc, "div", "dr-map");
      const controls = el(doc, "div", "dr-controls");
      const segs = el(doc, "div", this.sections.length ? "dr-segs" : "dr-spacer");
      this.total = Math.max(1, ...this.sections.map((s) => s.end));
      this.segs = this.sections.map((section) => {
        const button = el(doc, "button", "dr-seg", section.label);
        button.dataset.focusKey = `section:${section.start}`;
        button.style.flex = `${Math.max(0.15, section.end - section.start)} 1 0`;
        const pages = `p.${Math.floor(section.start) + 1}–${Math.max(Math.floor(section.start) + 1, Math.ceil(section.end))}`;
        button.title = `${section.number ? `${section.number} ` : ""}${section.title} · ${pages}`;
        button.addEventListener("click", () => this._goTo(section));
        segs.append(button);
        return button;
      });
      this.here = el(doc, "span", "dr-here");
      if (this.sections.length) segs.append(this.here);
      const sectionPicker = el(doc, "select", "dr-section-picker");
      sectionPicker.hidden = true;
      sectionPicker.dataset.focusKey = "section-picker";
      sectionPicker.setAttribute("aria-label", DeepRead.bilingual("跳到章节", "Jump to section"));
      const placeholder = el(doc, "option", "", DeepRead.bilingual("跳到章节…", "Jump to section…"));
      placeholder.value = "";
      sectionPicker.append(placeholder);
      this.sections.forEach((section, i) => {
        const option = el(doc, "option", "", `${section.number ? `${section.number} ` : ""}${section.title} · p.${Math.floor(section.start) + 1}`);
        option.value = String(i);
        sectionPicker.append(option);
      });
      sectionPicker.addEventListener("change", () => {
        if (sectionPicker.value !== "") this._goTo(this.sections[Number(sectionPicker.value)]);
      });
      this.sectionPicker = sectionPicker;
      this.readLabel = el(doc, "span", "dr-read");
      this.readLabel.title = DeepRead.bilingual("最远浏览到的位置；跳页也会推进此位置", "Furthest position reached; skipping pages also advances this position");
      map.append(segs, sectionPicker, this.readLabel);
      root.append(map, controls);
      this.map = map;
      this.controls = controls;

      // Keep question locations on a spacious map; an indexed selector remains usable when they overlap.
      this.qmarks = [];
      this.questionPicker = null;
      if (this.sections.length && DeepRead.Modules.enabled(this.session, "questions")) {
        const picker = el(doc, "select", "dr-question-picker");
        picker.dataset.focusKey = "question-picker";
        picker.setAttribute("aria-label", DeepRead.bilingual("跳到问题的原文出处", "Jump to a question's source"));
        const hint = el(doc, "option", "", DeepRead.bilingual("问题出处…", "Question sources…"));
        hint.value = "";
        picker.append(hint);
        for (const q of this.session.questions?.items || []) {
          const sources = (q.keys || []).map((key) => ({ key, at: this.session.keyPosition(key) }))
            .filter((source) => source.at !== null && /^p_\d+_\d+$/.test(source.key)).sort((a, b) => a.at - b.at);
          if (!sources.length) continue;
          const source = sources[0];
          const mark = el(doc, "button", "dr-qmark", this.session.questionLabel(q));
          mark.dataset.focusKey = `question:${q.id}`;
          mark.title = q.question;
          mark.setAttribute("aria-label", DeepRead.bilingual(`核对原文：${q.question}`, `Check source: ${q.question}`));
          mark.addEventListener("click", (e) => {
            e.stopPropagation();
            this._openQuestion(source.key);
          });
          segs.append(mark);
          this.qmarks.push({ mark, q, at: source.at });
          const option = el(doc, "option", "", `${this.session.questionLabel(q)} · p.${Math.floor(source.at) + 1} · ${q.question}`);
          option.value = source.key;
          picker.append(option);
        }
        picker.addEventListener("change", () => {
          if (picker.value) this._openQuestion(picker.value);
          picker.value = "";
        });
        if (this.qmarks.length) {
          hint.textContent = DeepRead.bilingual(`问题出处 (${this.qmarks.length})`, `${this.qmarks.length} questions…`);
          this.questionPicker = picker;
        }
      }
      this.depth = null;
      this.timeLabel = null;
      if (this.skim) {
        const depth = el(doc, "div", "dr-depth");
        depth.setAttribute("role", "group");
        depth.setAttribute("aria-label", DeepRead.bilingual("阅读深度", "Reading depth"));
        const modes = [["full", "全文", "Full"], ["key", "重点", "Key"], ["margin", "只看边注", "Margin only"]];
        for (const [mode, zh, en] of modes) {
          const button = el(doc, "button", "", DeepRead.bilingual(zh, en));
          button.dataset.mode = mode;
          button.dataset.focusKey = `depth:${mode}`;
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
        this.timeLabel.title = DeepRead.bilingual("按文字量粗估，实际用时取决于背景知识和阅读目标", "A rough estimate from text length; actual time depends on prior knowledge and reading goals");
        const next = el(doc, "button", "dr-nextkey", DeepRead.bilingual("下一个重点 ↓", "Next key ↓"));
        next.dataset.focusKey = "next-key";
        next.title = DeepRead.bilingual("跳到下一个重点段落（快捷键 N，Shift+N 上一个）", "Jump to the next key paragraph (N; Shift+N for the previous one)");
        next.addEventListener("click", () => this.goKey(1));
        controls.append(depth, this.timeLabel, next);
        this.depth = depth;
        const figures = this.session.figures();
        if (figures.length) {
          const select = el(doc, "select", "dr-figures");
          select.dataset.focusKey = "figures";
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
          controls.append(select);
        }
      }
      if (this.questionPicker) controls.append(this.questionPicker);
      controls.hidden = !controls.children.length;
      doc.body.append(root);
      doc.body.classList.add("deepread-has-bar");
      this.root = root;
      this.segBox = segs;
      this._layout();
      this._resizeObserver = new this.readerWin.ResizeObserver(() => { this._layout(); this.schedule(); });
      this._resizeObserver.observe(root);
      if (focusKey) {
        const focused = [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        if (focused?.getClientRects().length) focused.focus({ preventScroll: true });
        else if (focusKey.startsWith("section:") && !sectionPicker.hidden) sectionPicker.focus({ preventScroll: true });
      }
    }

    _openQuestion(key) {
      const match = /^p_(\d+)_(\d+)$/.exec(key || "");
      if (!match) return;
      this.session.openBlock(Number(match[1]), Number(match[2]));
      DeepRead.Panes?.reveal(this.session.reader, "questions");
    }

    _layout() {
      if (!this.root) return;
      this.root.classList.toggle("dr-compact", this.root.clientWidth < 1100);
      const available = this.map.clientWidth - this.readLabel.offsetWidth - 8;
      const picker = this.sections.length > 0 && available < Math.max(240, this.sections.length * 72);
      const active = this.readerDoc.activeElement;
      this.segBox.hidden = picker;
      this.sectionPicker.hidden = !picker;
      if (picker && this.segBox.contains(active)) {
        (active?.classList.contains("dr-qmark") ? this.questionPicker : this.sectionPicker)?.focus({ preventScroll: true });
      }
      else if (!picker && active === this.sectionPicker) {
        const current = this.segs.find((node) => node.classList.contains("dr-current")) || this.segs[0];
        current?.focus({ preventScroll: true });
      }
      const height = `${Math.ceil(this.root.getBoundingClientRect().height)}px`;
      if (this.readerDoc.body.style.getPropertyValue("--deepread-bar-height") !== height) {
        this.readerDoc.body.style.setProperty("--deepread-bar-height", height);
      }
    }

    _onKey(event) {
      if (event.key !== "n" && event.key !== "N") return;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
          || event.ctrlKey || event.metaKey || event.altKey || !this.skim) return;
      const target = event.target;
      if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return;
      event.preventDefault();
      this.goKey(event.shiftKey ? -1 : 1);
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
        const [dark, light, onLight] = COLORS[section.role] || COLORS.method;
        const span = section.end - section.start || 1;
        const read = Math.max(0, Math.min(1, (readUpTo - section.start) / span));
        const pct = Math.round(read * 100);
        const seg = this.segs[i];
        // Keep one readable label colour; progress lives below the text instead of splitting its background.
        seg.style.background = `linear-gradient(90deg, ${dark} 0 ${pct}%, transparent ${pct}% 100%) left bottom / 100% 3px no-repeat ${light}`;
        seg.style.color = onLight;
        seg.classList.toggle("dr-current", now >= section.start && now < section.end);
        if (now >= section.start && now < section.end) seg.setAttribute("aria-current", "location");
        else seg.removeAttribute("aria-current");
      });
      // Positions on the strip: inside the section's button (flex sizes are not linear in pages).
      const xOf = (position) => {
        const i = DeepRead.Structure.sectionAt(this.sections, Math.floor(position), (position % 1) * 1000);
        if (i < 0) return null;
        const section = this.sections[i];
        const frac = Math.max(0, Math.min(1, (position - section.start) / (section.end - section.start || 1)));
        return this.segs[i].offsetLeft + frac * this.segs[i].offsetWidth;
      };
      const markers = [];
      for (const { mark, q, at } of this.qmarks || []) {
        const x = xOf(at);
        mark.hidden = x === null || this.segBox.hidden;
        if (!mark.hidden) {
          const width = mark.offsetWidth;
          const left = Math.max(0, Math.min(this.segBox.clientWidth - width, x - width / 2));
          mark.style.insetInlineStart = `${left}px`;
          markers.push({ mark, left, right: left + width });
        }
        mark.classList.toggle("dr-reached", this.session.questionReached(q));
      }
      markers.sort((a, b) => a.left - b.left);
      if (markers.some((marker, i) => i > 0 && marker.left < markers[i - 1].right + 4)) {
        for (const { mark } of markers) {
          if (mark === this.readerDoc.activeElement) this.questionPicker?.focus({ preventScroll: true });
          mark.hidden = true;
        }
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
      // Do not disturb an open selector while the reader is choosing another section.
      if (this.sectionPicker && this.readerDoc.activeElement !== this.sectionPicker) this.sectionPicker.value = index >= 0 ? String(index) : "";
      const pages = this.app.pdfViewer.pagesCount || this.total;
      this.readLabel.textContent = DeepRead.bilingual(`浏览至 ${Math.min(100, Math.round((readUpTo / pages) * 100))}%`,
        `${Math.min(100, Math.round((readUpTo / pages) * 100))}% reached`);
      this._layout();
    }
  };
})();

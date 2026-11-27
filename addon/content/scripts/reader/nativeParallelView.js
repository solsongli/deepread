/* Continuous parallel reading inside Zotero's own split PDF views. AGPL-3.0-or-later. */
(function () {
  const raw = (object) => object?.wrappedJSObject || object;
  const tr = (zh, en) => DeepRead.bilingual(zh, en);
  const appOf = (view) => raw(view._iframeWindow).PDFViewerApplication;
  const element = (doc, tag, cls) => DeepRead.util.h(doc, tag, { class: cls });
  const stateOf = (viewer) => ({
    scrollMode: viewer.scrollMode,
    spreadMode: viewer.spreadMode,
    scale: viewer.currentScaleValue
  });
  function position(viewer) {
    const visible = viewer._getVisiblePages?.().first;
    const index = visible ? visible.id - 1 : viewer.currentPageNumber - 1;
    const div = viewer.getPageView(index)?.div;
    if (!div?.clientHeight) return null;
    const rect = div.getBoundingClientRect(),
      area = viewer.container.getBoundingClientRect();
    return {
      index,
      y: (area.top - rect.top - div.clientTop) / div.clientHeight,
      x: (area.left - rect.left - div.clientLeft) / div.clientWidth
    };
  }
  function align(viewer, anchor) {
    if (!anchor) return;
    const div = viewer.getPageView(anchor.index)?.div;
    if (!div?.clientHeight) return;
    const rect = div.getBoundingClientRect(),
      area = viewer.container.getBoundingClientRect(),
      box = viewer.container;
    const dy = rect.top + div.clientTop - area.top + anchor.y * div.clientHeight;
    const dx = rect.left + div.clientLeft - area.left + anchor.x * div.clientWidth;
    if (Math.abs(dy) > 0.9) box.scrollTop += dy;
    if (Math.abs(dx) > 0.9 && box.scrollWidth > box.clientWidth) box.scrollLeft += dx;
  }

  DeepRead.NativeParallelView = class NativeParallelView {
    constructor(reader) {
      this.reader = reader;
      this.ended = new Promise((resolve) => {
        this.finish = resolve;
      });
      this.cleanup = [];
      this.pages = new Map();
      this.wanted = new Set();
      this.driver = 0;
    }
    async open() {
      const { reader } = this,
        outer = (this.outer = reader.doc),
        host = (this.host = outer.getElementById("split-view"));
      const internal = (this.internal = raw(reader.session.reader._internalReader));
      const primary = internal._primaryView;
      this.left = appOf(primary);
      this.originalSplit = internal._state.splitType;
      this.primaryState = stateOf(this.left.pdfViewer);
      const anchor = position(this.left.pdfViewer);
      const existing = internal._secondaryView;
      if (existing) {
        await Promise.race([existing.initializedPromise, this.ended]);
        if (this.closed) return;
        const v = appOf(existing).pdfViewer;
        this.secondaryState = { ...stateOf(v), anchor: position(v), rotation: v.pagesRotation };
      }
      internal.toggleVerticalSplit(true);
      const secondary = (this.secondary = internal._secondaryView);
      await Promise.race([secondary.initializedPromise, this.ended]);
      if (this.closed) return;
      this.right = appOf(secondary);
      const rightDoc = (this.rightDoc = Components.utils.unwaiveXrays(secondary._iframeWindow.document));
      const sheet = DeepRead.util.readyStylesheet(
        rightDoc,
        "chrome://deepread/content/styles/parallel.css",
        "deepread-native-page-css"
      );
      DeepRead.util.injectStylesheet(
        rightDoc,
        "chrome://deepread/content/lib/katex/katex.min.css",
        "deepread-native-math-css"
      );
      await Promise.race([
        Promise.all([sheet, DeepRead.PaperType.ready(rightDoc, DeepRead.prefs.language())]),
        this.ended
      ]);
      if (this.closed) return;
      const apps = [this.left, this.right];
      for (const [side, app] of apps.entries()) {
        const view = app.pdfViewer;
        view.scrollMode = 0;
        view.spreadMode = 0;
        const win = view.container.ownerDocument.defaultView;
        const listen = (type, fn) => {
          const wrapped = Components.utils.exportFunction(fn, win);
          app.eventBus.on(type, wrapped);
          this.cleanup.push(() => app.eventBus.off(type, wrapped));
        };
        const input = () => {
          this.driver = side;
        };
        for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
          view.container.addEventListener(type, input, true);
          this.cleanup.push(() => view.container.removeEventListener(type, input, true));
        }
        // PDF.js also fires page/scale events while it lays out the other
        // pane. Only user input or an actual navigation chooses the driver.
        const update = () => this.schedule();
        view.container.addEventListener("scroll", update, { passive: true });
        this.cleanup.push(() => view.container.removeEventListener("scroll", update));
        for (const type of ["updateviewarea", "pagechanging", "scalechanging", "rotationchanging"])
          listen(type, update);
        listen("pagerendered", () => this.schedule());
        const highlight = (e) => this.highlight(side, e);
        const leave = () => this.clearHighlight();
        view.container.addEventListener("pointermove", highlight);
        view.container.addEventListener("pointerleave", leave);
        this.cleanup.push(() => {
          view.container.removeEventListener("pointermove", highlight);
          view.container.removeEventListener("pointerleave", leave);
        });
      }
      const leftViewer = this.left.pdfViewer;
      this.right.pdfViewer.currentScale = leftViewer.currentScale;
      align(leftViewer, anchor);
      align(this.right.pdfViewer, anchor);
      const toolbarInput = () => {
        this.driver = internal._lastViewPrimary === false ? 1 : 0;
      };
      for (const type of ["pointerdown", "keydown"]) {
        outer.addEventListener(type, toolbarInput, true);
        this.cleanup.push(() => outer.removeEventListener(type, toolbarInput, true));
      }
      this.ready = true;
      const observer = new outer.defaultView.MutationObserver(() => {
        if (
          !this.closed &&
          (!outer.body.classList.contains("enable-vertical-split-view") ||
            internal._secondaryView !== secondary)
        )
          reader.close(false, false);
      });
      observer.observe(outer.body, { attributes: true, attributeFilter: ["class"] });
      observer.observe(outer.getElementById("secondary-view"), { childList: true });
      this.cleanup.push(() => observer.disconnect());
      this.sync();
    }

    schedule() {
      if (!this.ready || this.closed || this.frame) return;
      this.frame = this.outer.defaultView.requestAnimationFrame(() => {
        this.frame = 0;
        this.sync();
      });
    }
    sync() {
      if (this.closed || !this.ready) return;
      const viewers = [this.left.pdfViewer, this.right.pdfViewer],
        source = viewers[this.driver],
        target = viewers[1 - this.driver];
      if (source.pagesRotation !== target.pagesRotation) target.pagesRotation = source.pagesRotation;
      if (Math.abs(source.currentScale - target.currentScale) > 0.001)
        target.currentScale = source.currentScale;
      const anchor = position(source);
      if (target.currentPageNumber !== source.currentPageNumber) {
        if (target._setCurrentPageNumber) target._setCurrentPageNumber(source.currentPageNumber, false);
        else target.currentPageNumber = source.currentPageNumber;
      }
      align(target, anchor);
      const v = this.right.pdfViewer,
        index = source.currentPageNumber - 1;
      const visible = v._getVisiblePages?.().views || [];
      const ordered = [...new Set([index, ...Array.from(visible, (e) => e.id - 1)])].filter(
        (i) => i >= 0 && i < this.reader.count
      );
      this.wanted = new Set(ordered);
      for (const [i, s] of this.pages) {
        const working = this.reader.surface === s && (this.reader.book || this.reader.page?.busy);
        if (!working && (s.rotation !== v.pagesRotation || !this.wanted.has(i))) {
          this.pages.delete(i);
          this.reader.releaseSurface(s);
          continue;
        }
        this.mount(s);
      }
      this.active = index;
      if (
        !this.reader.book &&
        !this.reader.exportJob &&
        !this.reader.page?.busy &&
        this.reader.surface !== this.pages.get(index)
      )
        this.reader.followPage(index);
      this.fill();
    }
    navigate(index) {
      if (!this.ready || index < 0 || index >= this.reader.count) return;
      this.driver = 0;
      const viewer = this.left.pdfViewer;
      if (viewer.currentPageNumber !== index + 1) viewer.currentPageNumber = index + 1;
      align(this.right.pdfViewer, position(viewer));
      this.active = index;
    }
    async fill() {
      if (this.filling) return;
      this.filling = true;
      try {
        while (!this.closed) {
          const index = [...this.wanted].find((i) => !this.pages.has(i));
          if (index == null) break;
          try {
            await this.ensure(index);
          } catch (error) {
            if (!this.closed) DeepRead.log("Parallel page", index + 1, String(error));
          }
        }
      } finally {
        this.filling = false;
      }
    }
    ensure(index) {
      let surface = this.pages.get(index);
      if (surface) return surface.promise;
      surface = this.reader.makeSurface(this.rightDoc, index, this.right.pdfViewer.pagesRotation);
      surface.nativeLayer = true;
      this.pages.set(index, surface);
      this.mount(surface);
      surface.promise = this.reader.compose(surface).then(() => {
        if (surface.controller.signal.aborted) return null;
        this.mount(surface);
        return surface;
      }, (error) => {
        // A page leaves the render window when the split changes scale or
        // the reader jumps. PDF.js rejects that render, but the split is open.
        if (surface.controller.signal.aborted) return null;
        throw error;
      });
      return surface.promise;
    }
    mount(s) {
      const view = this.right.pdfViewer.getPageView(s.index),
        div = view?.div;
      if (!div || s.controller.signal.aborted) return;
      if (s.host.parentNode !== div) div.append(s.host);
      if (!s.page) return;
      const scale = div.clientWidth / s.page.width;
      if (!(scale > 0)) return;
      s.target.stage.style.transform = "scale(" + scale + ")";
      s.page.screenDensity = scale * (this.rightDoc.defaultView.devicePixelRatio || 1);
      DeepRead.ParallelDetail.refresh(s, s.page);
    }
    painted(s) {
      if (!this.ready || this.pages.get(s.index) !== s) return;
      if (this.marked && (Components.utils.isDeadWrapper(this.marked) || !this.marked.isConnected))
        this.clearHighlight();
      // The real PDF.js page beneath the overlay owns figures, display
      // equations, annotations and zoom. Keep just the erased English ink
      // and local label patches in our backing canvas.
      const canvas = s.target.canvas,
        ctx = canvas.getContext("2d"),
        { page } = s;
      const sx = canvas.width / page.width,
        sy = canvas.height / page.height;
      if (page.dirtyRects.length) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        for (const r of page.dirtyRects) {
          const x = Math.floor(r.left * sx),
            y = Math.floor(r.top * sy);
          ctx.rect(x, y, Math.ceil((r.left + r.width) * sx) - x, Math.ceil((r.top + r.height) * sy) - y);
        }
        ctx.fill();
        ctx.restore();
      } else ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.mount(s);
      s.host.toggleAttribute(
        "data-translated",
        s.page.units.some((u) => u.placed && u.translation)
      );
      if (!s.more) {
        s.more = element(s.doc, "button", "dr-native-more");
        s.more.type = "button";
        s.more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.reader.openPassages(s);
        });
        s.host.append(s.more);
        s.host.addEventListener("click", (e) => {
          const link = e.target.closest?.("a[data-source-link]");
          if (link) {
            e.preventDefault();
            e.stopPropagation();
            this.reader.openReference(Number(link.dataset.sourceLink), s.page);
          }
        });
        s.host.addEventListener("copy", (e) => {
          const selection = s.doc.getSelection();
          if (!selection?.rangeCount) return;
          const fragment = selection.getRangeAt(0).cloneContents();
          const atoms = fragment.querySelectorAll("[role=math][aria-label]");
          if (!atoms.length) return;
          for (const atom of atoms) atom.replaceWith(s.doc.createTextNode(atom.getAttribute("aria-label")));
          e.clipboardData.setData("text/plain", fragment.textContent);
          e.preventDefault();
        });
      }
      for (const block of s.target.stage.querySelectorAll("[data-overflow]")) {
        block.removeAttribute("tabindex");
        block.title = tr(
          "本段的完整文字见本页「完整译文」",
          "Read the entire passage in Full passages on this page"
        );
      }
      s.more.hidden = !s.page.supplements.length;
      s.more.textContent = tr("完整译文", "Full passages") + " (" + s.page.supplements.length + ")";
    }
    accept(page) {
      const surface = this.pages.get(page.index);
      if (!surface || surface.page === page) return;
      const apply = () => {
        if (!surface.page?.units || surface.controller.signal.aborted) return;
        surface.page.saved = page.saved;
        surface.page.partial = page.partial || surface.page.partial;
        if (page.rasterLabels) surface.page.rasterLabels = page.rasterLabels;
        this.reader.prepareUnits(surface.page);
        this.reader.paintSurface(surface);
      };
      if (surface.page?.units) apply();
      else surface.promise?.then(apply).catch(() => {});
    }
    clearHighlight() {
      for (const outline of this.outlines || [])
        if (!Components.utils.isDeadWrapper(outline)) outline.remove();
      this.outlines = null;
      this.marked = null;
    }
    highlight(side, event) {
      const node = event.target.closest?.(".page[data-page-number]");
      const index = Number(node?.dataset.pageNumber) - 1,
        s = this.pages.get(index);
      if (!s?.page || !node.clientWidth || !node.clientHeight) {
        this.clearHighlight();
        return;
      }
      let block = side === 1 && event.target.closest?.(".dr-parallel-text[data-source-rect]");
      if (!block) {
        const rect = node.getBoundingClientRect(),
          x = ((event.clientX - rect.left - node.clientLeft) * s.page.width) / node.clientWidth,
          y = ((event.clientY - rect.top - node.clientTop) * s.page.height) / node.clientHeight;
        block = [...s.target.stage.querySelectorAll("[data-source-rect]")].find((b) => {
          const [l, t, w, h] = b.dataset.sourceRect.split(" ").map(Number);
          return x >= l && x <= l + w && y >= t && y <= t + h;
        });
      }
      if (block && block === this.marked && this.outlines?.every((o) => o.isConnected)) return;
      this.clearHighlight();
      if (!block) return;
      const [x, y, w, h] = block.dataset.sourceRect.split(" ").map(Number);
      const pages = [this.left.pdfViewer,this.right.pdfViewer].map(v=>v.getPageView(index)?.div);
      if (!pages.every(Boolean)) return;
      const outlines = [];
      for (const div of pages) {
        const outline = element(div.ownerDocument, "div", "dr-native-outline");
        outline.setAttribute("aria-hidden", "true");
        outline.style.cssText =
          "position:absolute;pointer-events:none;z-index:5;outline:1.5px solid #387ab2;";
        Object.assign(outline.style, {
          left: (x / s.page.width) * 100 + "%",
          top: (y / s.page.height) * 100 + "%",
          width: (w / s.page.width) * 100 + "%",
          height: (h / s.page.height) * 100 + "%"
        });
        div.append(outline);
        outlines.push(outline);
      }
      this.outlines = outlines;
      this.marked = block;
    }
    close(restore = true) {
      this.closed = true;
      this.ready = false;
      this.finish();
      if (this.frame) this.outer.defaultView.cancelAnimationFrame(this.frame);
      this.clearHighlight();
      for (const clean of this.cleanup.splice(0))
        try {
          clean();
        } catch {}
      for (const s of this.pages.values()) this.reader.releaseSurface(s);
      this.pages.clear();
      if (this.rightDoc && !Components.utils.isDeadWrapper(this.rightDoc)) {
        DeepRead.PaperType.remove(this.rightDoc);
        for (const id of ["deepread-native-page-css", "deepread-native-math-css"])
          this.rightDoc.getElementById(id)?.remove();
      }
      const left = this.left?.pdfViewer,
        anchor = left && position(left);
      if (restore && this.internal && this.internal._secondaryView === this.secondary) {
        if (!this.originalSplit) this.internal.disableSplitView();
        else {
          if (this.originalSplit === "horizontal") this.internal.toggleHorizontalSplit(true);
          const v = this.right?.pdfViewer,
            s = this.secondaryState;
          if (v && s) {
            v.scrollMode = s.scrollMode;
            v.spreadMode = s.spreadMode;
            v.pagesRotation = s.rotation;
            v.currentScaleValue = s.scale;
            align(v, s.anchor);
          }
        }
      }
      if (left && this.primaryState) {
        left.scrollMode = this.primaryState.scrollMode;
        left.spreadMode = this.primaryState.spreadMode;
        if (["page-width", "page-fit", "auto"].includes(this.primaryState.scale))
          left.currentScaleValue = this.primaryState.scale;
        align(left, anchor);
      }
    }
  };
})();

/*
 * Item-pane sections shown in reader tabs (Summary / AI Outline / AI Chat) and shared helpers.
 * Each section body is bound to the Session of the reader tab it belongs to and re-renders
 * whenever that session changes.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Services, Cc, Ci */

(function () {
  const bodies = new WeakMap(); // body element → { kind, session, unsubscribe }
  const paneIDs = {};
  const renderers = {}; // kind → (ctx) => void, registered by the pane files

  function readerForBody(body) {
    const win = body.ownerGlobal;
    const tabID = win?.Zotero_Tabs?.selectedID;
    const reader = tabID && Zotero.Reader.getByTabID(tabID);
    return reader && reader.type === "pdf" ? reader : null;
  }

  function unmount(body) {
    const state = bodies.get(body);
    if (state) {
      state.unsubscribe?.();
      bodies.delete(body);
    }
  }

  function mount(kind, body) {
    const reader = readerForBody(body);
    const session = reader ? DeepRead.Session.forReader(reader) : null;
    const previous = bodies.get(body);
    if (previous && previous.session === session) {
      render(body);
      return;
    }
    unmount(body);
    const state = { kind, session, unsubscribe: null };
    bodies.set(body, state);
    if (session) {
      state.unsubscribe = session.on((event) => {
        if (!body.isConnected) {
          unmount(body);
          return;
        }
        if (event !== "notify") render(body, event);
      });
      session.init();
    }
    render(body);
  }

  function render(body, event = "change") {
    const state = bodies.get(body);
    if (!state) return;
    const doc = body.ownerDocument;
    try {
      renderers[state.kind]?.({ body, doc, session: state.session, event, h: (...args) => DeepRead.util.h(doc, ...args) });
    }
    catch (e) {
      DeepRead.log(`render ${state.kind} failed: ${e}`, e?.stack || "");
    }
  }

  DeepRead.Panes = {
    renderers,
    paneIDs,

    registerAll(pluginID) {
      const icon = (name) => `chrome://deepread/content/icons/${name}.svg`;
      const common = (kind) => ({
        pluginID,
        onItemChange: ({ tabType, setEnabled }) => setEnabled(tabType === "reader"),
        onRender: ({ body }) => mount(kind, body),
        onDestroy: ({ body }) => unmount(body),
      });

      paneIDs.summary = Zotero.ItemPaneManager.registerSection({
        paneID: "deepread-summary",
        header: { l10nID: "deepread-pane-summary-header", icon: icon("summary") },
        sidenav: { l10nID: "deepread-pane-summary-sidenav", icon: icon("summary") },
        sectionButtons: [{
          type: "regenerate",
          icon: "chrome://zotero/skin/16/universal/refresh.svg",
          l10nID: "deepread-section-button-regenerate",
          onClick: ({ body }) => {
            const session = bodies.get(body)?.session;
            session?.regenerateSummary().catch((e) => DeepRead.Panes.reportError(session, e));
          },
        }],
        ...common("summary"),
      });

      paneIDs.outline = Zotero.ItemPaneManager.registerSection({
        paneID: "deepread-outline",
        header: { l10nID: "deepread-pane-outline-header", icon: icon("outline") },
        sidenav: { l10nID: "deepread-pane-outline-sidenav", icon: icon("outline") },
        sectionButtons: [{
          type: "regenerate",
          icon: "chrome://zotero/skin/16/universal/refresh.svg",
          l10nID: "deepread-section-button-regenerate",
          onClick: ({ body }) => {
            const session = bodies.get(body)?.session;
            session?.generateOutline().catch((e) => DeepRead.Panes.reportError(session, e));
          },
        }],
        ...common("outline"),
      });

      paneIDs.questions = Zotero.ItemPaneManager.registerSection({
        paneID: "deepread-questions",
        header: { l10nID: "deepread-pane-questions-header", icon: icon("questions") },
        sidenav: { l10nID: "deepread-pane-questions-sidenav", icon: icon("questions") },
        sectionButtons: [{
          type: "regenerate",
          icon: "chrome://zotero/skin/16/universal/refresh.svg",
          l10nID: "deepread-section-button-regenerate",
          onClick: ({ body }) => {
            const session = bodies.get(body)?.session;
            session?.generateQuestions().catch((e) => DeepRead.Panes.reportError(session, e));
          },
        }],
        ...common("questions"),
      });

      paneIDs.chat = Zotero.ItemPaneManager.registerSection({
        paneID: "deepread-chat",
        header: { l10nID: "deepread-pane-chat-header", icon: icon("chat") },
        sidenav: { l10nID: "deepread-pane-chat-sidenav", icon: icon("chat") },
        sectionButtons: [{
          type: "clear",
          icon: "chrome://zotero/skin/16/universal/trash.svg",
          l10nID: "deepread-section-button-clear-chat",
          onClick: ({ body }) => DeepRead.ChatPane.clear(bodies.get(body)?.session),
        }],
        ...common("chat"),
      });
    },

    /** Open the context pane of the reader's window and scroll to one of our sections. */
    reveal(reader, kind) {
      try {
        const win = reader._window || Zotero.getMainWindow();
        if (win.ZoteroContextPane?.collapsed) win.ZoteroContextPane.collapsed = false;
        const paneID = paneIDs[kind];
        const details = win.ZoteroContextPane?.sidenav?.container;
        if (paneID && details?.scrollToPane) details.scrollToPane(paneID, "smooth");
      }
      catch (e) {
        DeepRead.log("reveal failed", String(e));
      }
    },

    reportError(session, error) {
      const message = DeepRead.util.formatError(error);
      DeepRead.log("pane action failed", message);
      session?._notify(message, "error");
      if (error?.configError) DeepRead.openPreferences();
    },

    progressBar(h, percent) {
      const bar = h("div", { class: "dr-progress" }, h("div", { class: "dr-progress-fill" }));
      bar.firstChild.style.width = `${Math.max(2, Math.min(100, percent || 0))}%`;
      return bar;
    },

    noReader(h) {
      return h("div", { class: "dr-muted" }, DeepRead.bilingual("在 PDF 阅读器中可用", "Available in the PDF reader"));
    },
  };

  DeepRead.openPreferences = function () {
    try {
      Zotero.Utilities.Internal.openPreferences(DeepRead.prefPaneID);
    }
    catch (e) {
      DeepRead.log("openPreferences failed", String(e));
    }
  };

  /* ---------------- Markdown + math rendering ---------------- */

  DeepRead.Markdown = {
    _libs: null,

    libs() {
      if (!this._libs) {
        const scope = {};
        Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/marked/marked.js`, scope);
        Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/katex/katex.min.js`, scope);
        this._libs = {
          marked: scope.marked || globalThis.marked,
          katex: scope.katex || globalThis.katex,
        };
      }
      return this._libs;
    },

    _renderMath(tex, displayMode) {
      try {
        return this.libs().katex.renderToString(tex, { displayMode, throwOnError: false, output: "html" });
      }
      catch (e) {
        return null;
      }
    },

    toHTML(text) {
      const { marked } = this.libs();
      const maths = [];
      const stash = (tex, display) => {
        const html = this._renderMath(tex.trim(), display);
        if (html === null) return display ? `$$${tex}$$` : `$${tex}$`;
        maths.push(html);
        return `@@DRMATH${maths.length - 1}@@`;
      };
      // Leave fenced/inline code untouched; extract math from the rest.
      const segments = String(text || "").split(/(```[\s\S]*?```|`[^`\n]*`)/g);
      const processed = segments.map((seg, i) => {
        if (i % 2 === 1) return seg;
        return seg
          .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true))
          .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(tex, true))
          .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(tex, false))
          .replace(/(^|[^\\$\w])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\d)/g, (_, pre, tex) => pre + stash(tex, false));
      }).join("");
      let html = marked.parse(processed, { gfm: true, breaks: true });
      html = html.replace(/@@DRMATH(\d+)@@/g, (_, i) => maths[Number(i)] ?? "");
      return html;
    },

    /** Returns a sanitized DocumentFragment for `doc`. */
    render(doc, text, contextElement) {
      let html;
      try {
        html = this.toHTML(text);
      }
      catch (e) {
        DeepRead.log("markdown render failed", String(e));
        const frag = doc.createDocumentFragment();
        frag.append(doc.createTextNode(String(text || "")));
        return frag;
      }
      // Sanitize (drops scripts, event handlers, forms), then parse in an inert HTML document and
      // import the nodes: the main window is XHTML, where HTML fragment parsing is not available.
      const flags = Ci.nsIParserUtils.SanitizerAllowStyle | Ci.nsIParserUtils.SanitizerDropForms;
      const parserUtils = Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils);
      const clean = parserUtils.sanitize(html, flags);
      const parsed = new doc.defaultView.DOMParser().parseFromString(clean, "text/html");
      // No remote images in privileged UI (tracking pixels, layout blow-ups): turn them into links.
      for (const img of [...parsed.body.querySelectorAll("img")]) {
        const src = img.getAttribute("src") || "";
        const alt = img.getAttribute("alt") || "image";
        if (/^https?:\/\//i.test(src)) {
          const a = parsed.createElement("a");
          a.setAttribute("href", src);
          a.textContent = `[${alt}]`;
          img.replaceWith(a);
        }
        else {
          img.remove();
        }
      }
      const frag = doc.createDocumentFragment();
      for (const node of [...parsed.body.childNodes]) {
        frag.append(doc.importNode(node, true));
      }
      return frag;
    },

    /** Turn "(p. 3)" / "p. 3" / "p. 3 ¶2" references into clickable links: onPage(page, paragraph?) (1-based). */
    linkPageRefs(container, onPage) {
      const doc = container.ownerDocument;
      const walker = doc.createTreeWalker(container, 4 /* SHOW_TEXT */);
      const nodes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest("a, code, pre, .katex")) continue;
        if (/\bp(?:p|age)?\.?\s*\d+/i.test(node.nodeValue)) nodes.push(node);
      }
      const re = /\b(p(?:p|age)?\.?\s*)(\d+)(?:\s*¶\s*(\d+))?/gi;
      for (const node of nodes) {
        const text = node.nodeValue;
        const frag = doc.createDocumentFragment();
        let last = 0;
        for (const match of text.matchAll(re)) {
          frag.append(text.slice(last, match.index));
          const link = DeepRead.util.h(doc, "a", { href: "#", class: "dr-page-ref" }, match[0]);
          const page = Number(match[2]);
          const paragraph = match[3] ? Number(match[3]) : undefined;
          link.addEventListener("click", (e) => {
            e.preventDefault();
            onPage(page, paragraph);
          });
          frag.append(link);
          last = match.index + match[0].length;
        }
        frag.append(text.slice(last));
        node.replaceWith(frag);
      }
    },

    wireLinks(container) {
      container.addEventListener("click", (event) => {
        const a = event.target.closest?.("a[href]");
        if (!a || a.classList.contains("dr-page-ref")) return;
        event.preventDefault();
        const href = a.getAttribute("href");
        if (/^https?:\/\//i.test(href)) Zotero.launchURL(href);
      });
    },
  };
})();

/*
 * Text-selection popup: "翻译" (LLM translation of the selection, with copy / save-as-annotation)
 * and "问 AI" (quote the selection into the AI chat pane).
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const cache = new Map(); // `${lang}\n${text}` → translation
  const CACHE_LIMIT = 200;

  const CSS = `
.deepread-selection { display: flex; flex-direction: column; gap: 6px; padding: 6px 4px 2px; max-width: 420px; }
.deepread-selection .dr-buttons { display: flex; gap: 6px; }
.deepread-selection button { border: 1px solid var(--fill-quinary, rgba(0,0,0,0.12)); background: var(--material-button, transparent);
  color: inherit; border-radius: 5px; padding: 2px 9px; font-size: 12px; cursor: pointer; }
.deepread-selection button:hover { background: var(--fill-quinary, rgba(0,0,0,0.06)); }
.deepread-selection .dr-result { font-size: 13px; line-height: 1.55; white-space: pre-wrap; max-height: 260px; overflow: auto;
  user-select: text; -moz-user-select: text; }
.deepread-selection .dr-result.dr-error { color: #b42318; }
.deepread-selection .dr-muted { color: var(--fill-secondary, #666); font-size: 12px; }
`;

  function h(doc, tag, props = {}, ...children) {
    const node = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }

  function translationSystemPrompt() {
    const lang = DeepRead.PARSE_LANGUAGES[DeepRead.prefs.language()] || DeepRead.PARSE_LANGUAGES.zh;
    return [
      `You are a professional academic translator. Translate the user's text into ${lang.instruction}.`,
      "Output only the translation. Keep formulas, LaTeX, citations like [12], numbers and units unchanged.",
      "Keep well-established technical terms, model names and dataset names in English when that is clearer.",
      "The text was extracted from a PDF: join broken lines and remove hyphenation artifacts.",
    ].join("\n");
  }

  DeepRead.Translate = {
    async translate(text, { signal } = {}) {
      const source = String(text || "").trim();
      if (!source) return "";
      const key = `${DeepRead.prefs.language()}\n${source}`;
      if (cache.has(key)) return cache.get(key);
      const { content } = await DeepRead.LLM.complete({
        system: translationSystemPrompt(),
        messages: [{ role: "user", content: source }],
        temperature: 0.2,
        maxTokens: 4096,
        signal,
      });
      const translation = String(content || "").trim();
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, translation);
      return translation;
    },
  };

  async function saveAsAnnotation(reader, annotation, comment) {
    const item = Zotero.Items.get(reader.itemID);
    const json = {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: "highlight",
      color: annotation.color || "#ffd400",
      text: annotation.text || "",
      comment,
      pageLabel: annotation.pageLabel || "",
      sortIndex: annotation.sortIndex,
      position: annotation.position,
      tags: [],
    };
    await Zotero.Annotations.saveFromJSON(item, json);
  }

  function render(event) {
    const { reader, doc, params, append } = event;
    if (reader.type !== "pdf") return;
    const readerWin = doc.defaultView;
    // Copy the draft annotation out of the content compartment.
    let annotation;
    try {
      annotation = JSON.parse(readerWin.JSON.stringify(params.annotation));
    }
    catch (e) {
      annotation = { text: String(params.annotation?.text || "") };
    }
    const text = String(annotation.text || "").trim();
    if (!text) return;

    if (!doc.getElementById("deepread-selection-css")) {
      const style = doc.createElementNS(HTML_NS, "style");
      style.id = "deepread-selection-css";
      style.textContent = CSS;
      (doc.head || doc.documentElement).append(style);
    }

    const result = h(doc, "div", { class: "dr-result", hidden: "" });
    const extra = h(doc, "div", { class: "dr-buttons", hidden: "" });
    let translation = "";

    const translateButton = h(doc, "button", {
      onclick: async () => {
        if (!DeepRead.LLM.isConfigured()) {
          result.hidden = false;
          result.className = "dr-result dr-error";
          result.textContent = DeepRead.t("error.noLLM");
          return;
        }
        translateButton.disabled = true;
        result.hidden = false;
        result.className = "dr-result dr-muted";
        result.textContent = DeepRead.t("selection.translating");
        try {
          translation = await DeepRead.Translate.translate(text);
          result.className = "dr-result";
          result.textContent = translation;
          extra.hidden = false;
        }
        catch (error) {
          result.className = "dr-result dr-error";
          result.textContent = DeepRead.util.formatError(error);
        }
        finally {
          translateButton.disabled = false;
        }
      },
    }, DeepRead.t("selection.translate"));

    const askButton = h(doc, "button", {
      onclick: () => {
        const pageIndex = annotation.position?.pageIndex;
        DeepRead.Session.forReader(reader)?.askAI({ text, pageIndex: Number.isInteger(pageIndex) ? pageIndex : undefined });
      },
    }, DeepRead.t("selection.ask"));

    extra.append(
      h(doc, "button", { onclick: () => DeepRead.util.copyToClipboard(translation) }, DeepRead.t("selection.copy")),
      annotation.position
        ? h(doc, "button", {
          onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            try {
              await saveAsAnnotation(reader, annotation, translation);
              button.textContent = "✓";
            }
            catch (error) {
              DeepRead.log("save annotation failed", String(error));
              button.disabled = false;
            }
          },
        }, DeepRead.t("selection.saveComment"))
        : null);

    const container = h(doc, "div", { class: "deepread-selection" },
      h(doc, "div", { class: "dr-buttons" }, translateButton, askButton),
      result,
      extra);
    append(container);
  }

  DeepRead.Selection = {
    register(pluginID) {
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event) => {
        try {
          render(event);
        }
        catch (e) {
          DeepRead.log("renderTextSelectionPopup failed", e?.stack || String(e));
        }
      }, pluginID);
    },
  };
})();

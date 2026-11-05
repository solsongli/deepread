/*
 * Reader toolbar: "AI 精读" button with live progress, an options menu, and toasts.
 * Rendering the toolbar is also our signal that a reader opened, so sessions start here.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const CSS = `
.deepread-toolbar { display: flex; align-items: center; gap: 3px; }
.deepread-toolbar .toolbar-button { border-radius: var(--dr-control-radius, 6px); color: var(--dr-muted, #526075); }
.deepread-toolbar .toolbar-button:hover { background: var(--dr-surface-soft, #f4f6fa); color: var(--dr-text, #202939); }
.deepread-toolbar .toolbar-button:focus-visible { outline: 2px solid var(--dr-accent, #2459a9); outline-offset: 1px; }
.deepread-toolbar .dr-run { width: auto; min-width: 28px; padding: 0 9px; gap: 6px; font-size: 12px; font-weight: 600;
  color: var(--dr-accent, #2459a9); background: var(--dr-accent-soft, #eaf1fc); white-space: nowrap; position: relative; overflow: hidden; }
.deepread-toolbar .dr-run .dr-run-progress { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--dr-accent, #2459a9); transition: width .3s; }
.deepread-toolbar .dr-run.dr-ready::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--dr-success, #14664c); }
.deepread-toolbar .dr-menu-button, .deepread-toolbar .dr-focus-button, .deepread-toolbar .dr-questions-button,
.deepread-toolbar .dr-guide-button { width: auto; padding: 0 8px; gap: 5px; font-size: 12px; white-space: nowrap; }
.deepread-toolbar .dr-focus-button[aria-pressed="true"], .deepread-toolbar .dr-guide-button[aria-pressed="true"],
.deepread-toolbar .dr-menu-button[aria-expanded="true"] { color: var(--dr-accent, #2459a9); background: var(--dr-accent-soft, #eaf1fc); }
.deepread-toolbar .dr-focus-button[hidden], .deepread-toolbar .dr-questions-button[hidden], .deepread-toolbar .dr-guide-button[hidden] { display: none; }
.deepread-toolbar .dr-guide-button.dr-ready::after { content: " ✓"; }
.deepread-toolbar .dr-menu-button .dr-count { font-weight: 400; color: var(--dr-muted, #526075); font-size: 10.5px; }
.deepread-menu { position: fixed; z-index: 2147483001; width: 340px; max-width: calc(100vw - 16px); min-width: 0;
  box-sizing: border-box; padding: 0; border-radius: var(--dr-radius, 10px); overflow: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--dr-muted, #526075) var(--dr-surface-soft, #f4f6fa);
  background: var(--dr-surface, #fff); color: var(--dr-text, #202939); border: 1px solid var(--dr-border, #d8dee8);
  box-shadow: var(--dr-popover-shadow, 0 12px 36px rgba(20,35,55,0.16));
  font: 12.5px/1.45 var(--dr-font, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif); }
.deepread-menu button { display: flex; width: 100%; gap: 8px; align-items: center; text-align: start; padding: 7px 9px;
  border: none; background: transparent; color: inherit; border-radius: var(--dr-control-radius, 6px); font: inherit; cursor: pointer; }
.deepread-menu button:hover { background: var(--dr-surface-soft, #f4f6fa); }
.deepread-menu :is(button,select,input):focus-visible { outline: 2px solid var(--dr-accent, #2459a9); outline-offset: -2px; }
.deepread-menu button:disabled, .deepread-menu select:disabled { opacity: .45; cursor: default; }
.deepread-menu .dr-check { display: none; }
.deepread-menu .dr-menu-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 8px; padding: 12px 13px; background: var(--dr-surface, #fff); border-bottom: 1px solid var(--dr-border, #d8dee8); }
.deepread-menu .dr-menu-head strong { font-size: 13px; font-weight: 650; }
.deepread-menu .dr-menu-section { padding: 9px 8px; }
.deepread-menu .dr-menu-section + .dr-menu-section { border-top: 1px solid var(--dr-border, #d8dee8); }
.deepread-menu .dr-section-label { margin: 0 0 4px; padding: 2px 9px 4px; color: var(--dr-muted, #526075); font-size: 11px; font-weight: 600; }
.deepread-menu .dr-scope { display: flex; padding: 2px; border: 1px solid var(--dr-border, #d8dee8); border-radius: 7px; background: var(--dr-surface-soft, #f4f6fa); }
.deepread-menu .dr-scope button { width: auto; padding: 3px 8px; border-radius: 4px; font-size: 11px; color: var(--dr-muted, #526075); }
.deepread-menu .dr-scope button[aria-pressed="true"] { background: var(--dr-surface, #fff); color: var(--dr-accent, #2459a9); box-shadow: 0 1px 3px rgba(20,35,55,.1); }
.deepread-menu .dr-feature { align-items: flex-start; gap: 10px; padding: 7px 9px; }
.deepread-menu .dr-box { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; border-radius: 4px; box-sizing: border-box;
  border: 1px solid var(--dr-muted, #526075); display: grid; place-items: center; color: var(--dr-surface, #fff); font-size: 11px; line-height: 1; }
.deepread-menu .dr-feature[aria-checked="true"] .dr-box { background: var(--dr-accent, #2459a9); border-color: var(--dr-accent, #2459a9); color: var(--dr-on-accent, #fff); }
.deepread-menu .dr-feature-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.deepread-menu .dr-feature-text strong { font-weight: 550; }
.deepread-menu .dr-feature-text small { font-size: 11px; line-height: 1.45; color: var(--dr-muted, #526075); }
.deepread-menu .dr-menu-row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 6px 9px; min-width: 0; }
.deepread-menu .dr-menu-row .dr-label { flex: 1 1 100px; }
.deepread-menu .dr-menu-row button { width: auto; min-width: 26px; min-height: 25px; padding: 2px 7px; justify-content: center;
  border: 1px solid var(--dr-border, #d8dee8); background: var(--dr-surface, #fff); }
.deepread-menu .dr-menu-row .dr-value { min-width: 42px; text-align: center; color: var(--dr-muted, #526075); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.deepread-menu .dr-menu-row select { min-width: 90px; max-width: 100%; padding: 4px 6px; font: inherit; color: inherit;
  background: var(--dr-surface, #fff); border: 1px solid var(--dr-border, #d8dee8); border-radius: var(--dr-control-radius, 6px); }
.deepread-menu .dr-hl-row input[type="color"] { width: 22px; height: 24px; padding: 1px; border: 1px solid var(--dr-border, #d8dee8);
  border-radius: 5px; background: var(--dr-surface, #fff); cursor: pointer; }
.deepread-menu .dr-fold-row button[aria-pressed="true"] { background: var(--dr-accent-soft, #eaf1fc); border-color: var(--dr-accent, #2459a9); color: var(--dr-accent, #2459a9); }
.deepread-menu .dr-menu-actions > button { padding: 8px 9px; }
.deepread-menu .dr-menu-danger { color: var(--dr-danger, #b4233b); }
.deepread-toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483002; max-width: min(380px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 14px;
  border-radius: var(--dr-radius, 10px); background: #202939; color: #fff; font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
  box-shadow: 0 6px 20px rgba(20,35,55,0.2); white-space: pre-wrap; }
.deepread-toast.dr-error { background: #9f2b27; }
.deepread-toast.dr-warning { background: #8b5710; }
`;

  function h(doc, tag, props = {}, ...children) {
    const node = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    node.append(...children.flat().filter((c) => c !== null && c !== undefined));
    return node;
  }

  function injectCSS(doc) {
    DeepRead.UI?.install(doc);
    if (doc.getElementById("deepread-toolbar-css")) return;
    const style = doc.createElementNS(HTML_NS, "style");
    style.id = "deepread-toolbar-css";
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
  }

  DeepRead.Toast = {
    show(doc, message, type = "info", ms = 4500) {
      if (!doc || !message) return;
      injectCSS(doc);
      doc.querySelector(".deepread-toast")?.remove();
      const toast = h(doc, "div", { class: `deepread-toast dr-${type}` }, String(message));
      (doc.body || doc.documentElement).append(toast);
      setTimeout(() => toast.remove(), type === "error" ? Math.max(ms, 8000) : ms);
    },
  };

  function confirm(reader, message) {
    return Services.prompt.confirm(reader._window || null, "DeepRead", message);
  }

  async function onRun(session, doc) {
    if (session.status === "running") {
      if (confirm(session.reader, DeepRead.bilingual("取消正在进行的精读？", "Cancel the running deep read?"))) session.cancel();
      return;
    }
    if (session.hasResults && !confirm(session.reader, DeepRead.t("toolbar.confirmRerun"))) return;
    try {
      await session.run();
      DeepRead.Toast.show(doc, DeepRead.t("flow.done"));
      DeepRead.Panes.reveal(session.reader, "summary");
    }
    catch (error) {
      DeepRead.Toast.show(doc, DeepRead.util.formatError(error), "error");
      if (error?.configError) DeepRead.openPreferences();
    }
  }

  /** "生成 AI 讲解" for papers deep-read before explanations existed (or after they were turned off). */
  function explainItem(session, doc, item) {
    if (!session.hasResults || !DeepRead.Explainer) return null;
    const missing = session.missingExplanations().length;
    const running = session.explaining.size;
    if (!missing && !running) {
      // Everything explained: offer a fresh pass (e.g. to merge related paragraphs into one card).
      if (!Object.keys(session.explanations || {}).length) return null;
      const keys = (session.data?.hierarchicalData || []).flatMap((page) => (page.paragraphs || [])
        .filter((p) => DeepRead.Explainer.eligible(p)).map((p) => DeepRead.Explainer.key(page.pageIndex, p.paragraphIndex)));
      const label = DeepRead.prefs.get("cards.groupParagraphs") !== false
        ? DeepRead.bilingual("重新生成全部 AI 讲解（合并相关段落）", "Rewrite all explanations (merging related paragraphs)")
        : DeepRead.bilingual("重新生成全部 AI 讲解", "Rewrite all explanations");
      return item([h(doc, "span", { class: "dr-check" }), label], () => {
        session.explainAll({ only: keys })
          .then((count) => DeepRead.Toast.show(doc, DeepRead.bilingual(`已生成 ${count} 段 AI 讲解`, `${count} explanations written`)))
          .catch((error) => DeepRead.Toast.show(doc, DeepRead.util.formatError(error), "error"));
      });
    }
    const label = running
      ? DeepRead.bilingual(`AI 讲解生成中（${running} 段）…`, `Writing explanations (${running})…`)
      : DeepRead.bilingual(`生成 AI 讲解（${missing} 段）`, `Explain paragraphs (${missing})`);
    return item([h(doc, "span", { class: "dr-check" }), label], () => {
      if (running) return;
      session.explainAll()
        .then((count) => DeepRead.Toast.show(doc, DeepRead.bilingual(`已生成 ${count} 段 AI 讲解`, `${count} explanations written`)))
        .catch((error) => {
          DeepRead.Toast.show(doc, DeepRead.util.formatError(error), "error");
          if (error?.configError) DeepRead.openPreferences();
        });
    });
  }

  /** A menu row with −/+ buttons that adjust a numeric pref without closing the menu. */
  function sizeRow(doc, label, prefKey, step, clamp, format) {
    const value = h(doc, "span", { class: "dr-value" });
    const current = () => clamp(DeepRead.prefs.number(prefKey, NaN));
    const sync = () => { value.textContent = format(current()); };
    const change = (delta) => (e) => {
      e.stopPropagation();
      DeepRead.prefs.set(prefKey, clamp(current() + delta));
      sync();
    };
    sync();
    return h(doc, "div", { class: "dr-menu-row" }, h(doc, "span", { class: "dr-label" }, label),
      h(doc, "button", { onclick: change(-step), title: "−" }, "−"), value, h(doc, "button", { onclick: change(step), title: "+" }, "+"));
  }

  let featureScope = "paper"; // 「功能」 menu: apply switches to this paper only, or make them the default
  const openMenus = new WeakMap(); // document → cleanup, including listeners on its PDF iframe
  const activeMenus = new Set(); // shutdown may receive another Gecko wrapper for the same document

  /** The 「功能」 menu: per-paper module switches, card size, and the paper's actions. */
  function openMenu(session, doc, anchor) {
    openMenus.get(doc)?.({ restoreFocus: false });
    doc.querySelector(".deepread-menu")?.remove();
    let layoutTimer = null;
    const pdfDoc = session.overlay?.pdfDoc;
    const outerDoc = (session.reader._window || Zotero.getMainWindow())?.document;
    const close = ({ restoreFocus = true } = {}) => {
      menu.remove();
      clearTimeout(layoutTimer);
      doc.removeEventListener("pointerdown", outside, true);
      pdfDoc?.removeEventListener("pointerdown", outside, true);
      outerDoc?.removeEventListener("pointerdown", onOuterPointer, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.defaultView.removeEventListener("resize", onResize);
      doc.defaultView.removeEventListener("pagehide", onPageHide);
      if (openMenus.get(doc) === close) openMenus.delete(doc);
      activeMenus.delete(close);
      anchor.setAttribute("aria-expanded", "false");
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    const outside = (e) => {
      if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close({ restoreFocus: false });
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    const onResize = () => close({ restoreFocus: menu.contains(doc.activeElement) });
    const onPageHide = () => close({ restoreFocus: false });
    const onOuterPointer = () => close({ restoreFocus: false });
    const item = (content, action) => h(doc, "button", {
      onclick: (e) => {
        e.stopPropagation();
        close();
        action();
      },
    }, ...content);
    const plain = (label) => [h(doc, "span", { class: "dr-check" }), label];

    const scopeButton = (scope, label) => h(doc, "button", {
      "aria-pressed": String(featureScope === scope),
      onclick: (e) => {
        e.stopPropagation();
        featureScope = scope;
        for (const b of scopeBox.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      },
    }, label);
    const scopeBox = h(doc, "div", { class: "dr-scope", role: "group", "aria-label": DeepRead.bilingual("作用范围", "Scope") },
      scopeButton("paper", DeepRead.bilingual("仅本文", "This paper")),
      scopeButton("default", DeepRead.bilingual("设为默认", "Default")));

    const splitLayout = () => DeepRead.prefs.get("view.railLayout") !== "right";
    const cardsHint = () => {
      if (!splitLayout()) return DeepRead.bilingual("全部放在右侧", "All on the right");
      return session.rail?.leftRoot
        ? DeepRead.bilingual("本文双栏 · 两侧显示", "Two columns · both sides")
        : DeepRead.bilingual("单栏一侧、双栏两侧，自动判断", "One side, or both sides for two-column papers");
    };
    const featureRow = (module) => {
      const on = DeepRead.Modules.enabled(session, module.key);
      const hint = module.key === "cards" ? cardsHint() : DeepRead.Modules.hint(module);
      return h(doc, "button", {
        class: "dr-feature",
        role: "checkbox", "data-module": module.key,
        "aria-checked": String(on),
        onclick: (e) => {
          e.stopPropagation();
          DeepRead.Modules.set(session, module.key, !DeepRead.Modules.enabled(session, module.key), featureScope);
          density.disabled = !DeepRead.Modules.enabled(session, "highlights");
          if (featureScope === "default") DeepRead.Session.forEachOverlay((overlay) => overlay.session.applyModules());
          rows.replaceChildren(...DeepRead.Modules.LIST.map(featureRow));
          rows.querySelector(`[data-module="${module.key}"]`)?.focus();
        },
      }, h(doc, "span", { class: "dr-box", "aria-hidden": "true" }, on ? "✓" : ""),
      h(doc, "span", { class: "dr-feature-text" }, h(doc, "strong", {}, DeepRead.Modules.label(module)), hint ? h(doc, "small", {}, hint) : null));
    };
    const rows = h(doc, "div", { role: "group" }, ...DeepRead.Modules.LIST.map(featureRow));
    // Card placement is a global setting (the rail rebuilds through its pref observer).
    const layoutRow = () => h(doc, "button", {
      class: "dr-feature dr-layout",
      role: "checkbox",
      "aria-checked": String(splitLayout()),
      onclick: (e) => {
        e.stopPropagation();
        DeepRead.prefs.set("view.railLayout", splitLayout() ? "right" : "split");
        layout.replaceChildren(layoutRow());
        layout.querySelector("button")?.focus();
        layoutTimer = doc.defaultView.setTimeout(() => rows.replaceChildren(...DeepRead.Modules.LIST.map(featureRow)), 50);
      },
    }, h(doc, "span", { class: "dr-box", "aria-hidden": "true" }, splitLayout() ? "✓" : ""),
    h(doc, "span", { class: "dr-feature-text" }, h(doc, "strong", {}, DeepRead.bilingual("双栏论文两侧放卡片", "Cards on both sides for two columns")),
      h(doc, "small", {}, DeepRead.bilingual("关闭后卡片都放在右侧", "Off: all cards on the right"))));
    const layout = h(doc, "div", {}, layoutRow());
    // Opened cards stay open until closed (global).
    const keepOpenRow = () => {
      const on = DeepRead.prefs.get("cards.keepOpen") !== false;
      return h(doc, "button", {
        class: "dr-feature dr-keepopen",
        role: "checkbox",
        "aria-checked": String(on),
        onclick: (e) => {
          e.stopPropagation();
          DeepRead.prefs.set("cards.keepOpen", !on);
          keepOpen.replaceChildren(keepOpenRow());
          keepOpen.querySelector("button")?.focus();
        },
      }, h(doc, "span", { class: "dr-box", "aria-hidden": "true" }, on ? "✓" : ""),
      h(doc, "span", { class: "dr-feature-text" }, h(doc, "strong", {}, DeepRead.bilingual("卡片保持展开", "Keep opened cards open")),
        h(doc, "small", {}, DeepRead.bilingual("点别处不会自动收起，单击卡片标题收起", "Clicking elsewhere does not fold them; click a card's title to fold"))));
    };
    const keepOpen = h(doc, "div", {}, keepOpenRow());
    // Highlighter: one swatch per click step (colour 1, colour 2, …, then cleared).
    const highlightRow = () => {
      const colors = DeepRead.prefs.highlightColors();
      const save = (list) => {
        DeepRead.prefs.setHighlightColors(list);
        highlight.replaceChildren(highlightRow());
      };
      const swatches = colors.map((color, i) => {
        const input = h(doc, "input", { type: "color", value: color, title: DeepRead.bilingual(`第 ${i + 1} 次点击`, `Click ${i + 1}`) });
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("change", () => save(colors.map((c, j) => (j === i ? input.value : c))));
        return input;
      });
      const palette = ["#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#6366f1"];
      const step = (delta) => (e) => {
        e.stopPropagation();
        if (delta > 0) save([...colors, palette.find((c) => !colors.includes(c)) || "#22c55e"]);
        else if (colors.length > 1) save(colors.slice(0, -1));
      };
      return h(doc, "div", { class: "dr-menu-row dr-hl-row", title: DeepRead.bilingual("点击要点依次换成这些颜色，再点一次清除", "Clicking a key point steps through these colours; one more click clears it") },
        h(doc, "span", { class: "dr-label" }, DeepRead.bilingual("荧光笔", "Highlighter")), ...swatches,
        h(doc, "button", { onclick: step(-1), title: "−", disabled: colors.length <= 1 }, "−"),
        h(doc, "button", { onclick: step(1), title: "+", disabled: colors.length >= 6 }, "+"));
    };
    const highlight = h(doc, "div", {}, highlightRow());
    const density = h(doc, "select", { class: "dr-highlight-density", "aria-label": DeepRead.bilingual("本文自动高亮密度", "Automatic highlight density for this paper"),
      onchange: (e) => { e.stopPropagation(); session.setHighlightDensity(e.target.value); } });
    for (const [value, zh, en] of [["manual", "仅手动", "Manual only"], ["sparse", "少量", "Sparse"], ["standard", "标准", "Standard"], ["detailed", "更多", "More"]]) {
      density.append(h(doc, "option", { value }, DeepRead.bilingual(zh, en)));
    }
    density.value = session.highlightDensity;
    density.disabled = !DeepRead.Modules.enabled(session, "highlights");
    density.addEventListener("click", (e) => e.stopPropagation());
    // Fold the card rails away, e.g. while the AI chat pane takes the right side.
    const foldRow = () => {
      const button = (side, label) => {
        const pref = DeepRead.Rail.collapsePref(side);
        const folded = DeepRead.prefs.get(pref) === true;
        return h(doc, "button", {
          "aria-pressed": String(folded),
          onclick: (e) => {
            e.stopPropagation();
            DeepRead.prefs.set(pref, !folded);
            fold.replaceChildren(foldRow());
          },
        }, label);
      };
      return h(doc, "div", { class: "dr-menu-row dr-fold-row" }, h(doc, "span", { class: "dr-label" }, DeepRead.bilingual("收起卡片栏", "Fold card rail")),
        button("left", DeepRead.bilingual("左", "Left")), button("right", DeepRead.bilingual("右", "Right")));
    };
    const fold = h(doc, "div", {}, foldRow());

    const section = (label, className, ...children) => h(doc, "section", { class: `dr-menu-section ${className}`, "aria-label": label },
      h(doc, "h3", { class: "dr-section-label" }, label), ...children);
    const menu = h(doc, "div", { class: "deepread-menu dr-features", role: "dialog", "aria-label": DeepRead.bilingual("阅读显示设置", "Reading display settings") },
      h(doc, "div", { class: "dr-menu-head" }, h(doc, "strong", {}, DeepRead.bilingual("本文显示的功能", "Features")), scopeBox),
      section(DeepRead.bilingual("显示功能", "Visible features"), "dr-menu-features", rows),
      section(DeepRead.bilingual("版面与标记", "Layout and highlights"), "dr-menu-layout",
      sizeRow(doc, DeepRead.bilingual("卡片字号", "Card font"), "view.cardFontSize", 1, DeepRead.Rail.clampFont, (v) => `${v} px`),
      sizeRow(doc, DeepRead.bilingual("卡片宽度", "Card width"), "view.railWidth", 20, DeepRead.Rail.clampWidth, (v) => `${v} px`),
      layout,
      keepOpen,
      highlight,
      h(doc, "label", { class: "dr-menu-row", title: DeepRead.bilingual("只改变本文的自动建议，保留手动标记", "Affects this paper's automatic suggestions; keeps manual marks") },
        h(doc, "span", { class: "dr-label" }, DeepRead.bilingual("自动高亮（本文）", "Auto highlights (this paper)")), density),
      fold),
      section(DeepRead.bilingual("论文操作", "Paper actions"), "dr-menu-actions",
      item(plain(session.hasResults ? DeepRead.t("toolbar.rerun") : DeepRead.t("toolbar.run")), () => onRun(session, doc)),
      explainItem(session, doc, item),
      session.rail?.openCount
        ? item(plain(DeepRead.bilingual(`收起所有展开的卡片（${session.rail.openCount}）`, `Fold all open cards (${session.rail.openCount})`)),
          () => session.rail.collapseAll())
        : null,
      session.hiddenCardCount
        ? item(plain(DeepRead.bilingual(`显示已隐藏的卡片（${session.hiddenCardCount}）`, `Show hidden cards (${session.hiddenCardCount})`)),
          () => session.showHiddenCards())
        : null,
      item(plain(DeepRead.bilingual("DeepRead 设置…", "DeepRead settings…")), () => DeepRead.openPreferences()),
      session.hasResults
        ? item(plain(DeepRead.t("toolbar.clear")), async () => {
          if (confirm(session.reader, DeepRead.t("toolbar.confirmClear"))) await session.clearResults();
        })
        : null));
    menu.querySelector(".dr-menu-actions > button:last-child")?.classList.toggle("dr-menu-danger", session.hasResults);
    (doc.body || doc.documentElement).append(menu);
    const r = anchor.getBoundingClientRect();
    const winHeight = doc.documentElement.clientHeight, winWidth = doc.documentElement.clientWidth;
    const below = winHeight - r.bottom - 12, above = r.top - 12;
    const placeAbove = below < 220 && above > below;
    menu.style.maxHeight = `${Math.max(40, placeAbove ? above : below)}px`;
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.right - width, winWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(placeAbove ? r.top - menu.offsetHeight - 6 : r.bottom + 6, winHeight - menu.offsetHeight - 8))}px`;
    openMenus.set(doc, close);
    activeMenus.add(close);
    anchor.setAttribute("aria-expanded", "true");
    doc.addEventListener("pointerdown", outside, true);
    pdfDoc?.addEventListener("pointerdown", outside, true);
    outerDoc?.addEventListener("pointerdown", onOuterPointer, true);
    doc.addEventListener("keydown", onKey, true);
    doc.defaultView.addEventListener("resize", onResize);
    doc.defaultView.addEventListener("pagehide", onPageHide);
    scopeBox.querySelector("[aria-pressed='true']")?.focus();
  }

  function render(event) {
    const { reader, doc, append } = event;
    const session = DeepRead.Session.forReader(reader);
    if (!session) return;
    injectCSS(doc);
    openMenus.get(doc)?.({ restoreFocus: false });
    doc.querySelectorAll(".deepread-toolbar").forEach((node) => node.remove());

    const progress = h(doc, "div", { class: "dr-run-progress" });
    const label = h(doc, "span", {}, DeepRead.t("toolbar.run"));
    const runButton = h(doc, "button", { class: "toolbar-button dr-run", onclick: () => onRun(session, doc) }, label, progress);
    const count = h(doc, "span", { class: "dr-count" });
    const menuButton = h(doc, "button", {
      class: "toolbar-button dr-menu-button",
      title: DeepRead.bilingual("本文显示的功能", "Features for this paper"),
      "aria-haspopup": "dialog", "aria-expanded": "false",
      onclick: (e) => {
        if (doc.querySelector(".deepread-menu.dr-features")) {
          openMenus.get(doc)?.();
          return;
        }
        openMenu(session, doc, e.currentTarget);
      },
    }, DeepRead.bilingual("功能", "Features"), count, "▾");
    const updateCount = () => {
      const { on, total } = DeepRead.Modules.count(session);
      count.textContent = `${on}/${total}`;
    };
    // Question-led reading: how many answers the reader has reached; opens the questions section.
    const questionsButton = h(doc, "button", {
      class: "toolbar-button dr-questions-button",
      title: DeepRead.bilingual("阅读问题：已浏览到出处的数量", "Reading questions: source locations reached"),
      onclick: () => DeepRead.Panes?.reveal(reader, "questions"),
    });
    const updateQuestions = () => {
      const on = DeepRead.Modules.enabled(session, "questions") && session.hasResults;
      questionsButton.hidden = !on;
      if (!on) return;
      const { reached, total } = session.questionProgress();
      questionsButton.textContent = session.generatingQuestions && !total
        ? DeepRead.bilingual("问题…", "Questions…")
        : `${DeepRead.bilingual("问题", "Questions")} ${reached}/${total || 5}`;
    };
    // 带读: opens the guided-reading panel; shows when the agent is working.
    const guideButton = h(doc, "button", {
      class: "toolbar-button dr-guide-button",
      title: DeepRead.bilingual("带读：定位 → 骨架 → 方法 → 证据 → 带走", "Guided reading: position → skeleton → method → evidence → takeaway"),
      onclick: () => session.guidePanel?.toggle(),
    });
    const updateGuide = () => {
      const on = DeepRead.Modules.enabled(session, "guided") && session.hasResults;
      guideButton.hidden = !on;
      if (!on) return;
      const status = session.guideStatus;
      guideButton.textContent = status === "running" || status === "structuring" ? DeepRead.bilingual("带读…", "Guide…")
        : DeepRead.bilingual("带读", "Guide");
      guideButton.classList.toggle("dr-ready", status === "ready");
      guideButton.setAttribute("aria-pressed", String(!!session.guidePanel?.isOpen));
    };
    const focusButton = h(doc, "button", {
      class: "toolbar-button dr-focus-button",
      title: DeepRead.bilingual("只展开当前段落；其他卡片保留摘要（仅本文）", "Open only the current paragraph; keep other cards as summaries (this paper)"),
      onclick: () => session.setFocusReading(!session.focusReading),
    }, DeepRead.bilingual("专注", "Focus"));
    const updateFocus = () => {
      focusButton.hidden = !session.hasResults || !DeepRead.Modules.enabled(session, "cards");
      focusButton.setAttribute("aria-pressed", String(session.focusReading));
    };
    const container = h(doc, "div", { class: "deepread-toolbar" }, runButton, focusButton, questionsButton, guideButton, menuButton);

    const update = () => {
      const running = session.status === "running";
      label.textContent = running
        ? `${DeepRead.bilingual("精读", "Reading")} ${Math.round(session.progress.percent || 0)}%`
        : DeepRead.t("toolbar.run");
      runButton.title = running
        ? `${session.progress.message || ""}\n${DeepRead.bilingual("点击取消", "Click to cancel")}`
        : (session.hasResults ? DeepRead.bilingual("已精读 · 点击重新精读", "Deep-read · click to run again") : DeepRead.t("toolbar.run"));
      runButton.classList.toggle("dr-ready", session.hasResults && !running);
      progress.style.width = running ? `${Math.max(2, session.progress.percent || 0)}%` : "0";
    };
    const unsubscribe = session.on((type, payload) => {
      if (!container.isConnected) {
        unsubscribe();
        return;
      }
      if (type === "notify" && payload?.message) {
        DeepRead.Toast.show(doc, payload.message, payload.type);
        return;
      }
      if (type === "change" || type === "progress") update();
      if (type === "modules" || type === "change") updateCount();
      if (type === "modules" || type === "change" || type === "reading-view") updateFocus();
      if (type === "modules" || type === "change" || type === "questions") updateQuestions();
      if (type === "modules" || type === "change" || type === "guide" || type === "guidePanel") updateGuide();
    });
    update();
    updateCount();
    updateFocus();
    updateQuestions();
    updateGuide();
    append(container);
    session.init().then(update);
  }

  DeepRead.Toolbar = {
    register(pluginID) {
      Zotero.Reader.registerEventListener("renderToolbar", (event) => {
        try {
          render(event);
        }
        catch (e) {
          DeepRead.log("renderToolbar failed", e?.stack || String(e));
        }
      }, pluginID);
      // Readers that were already open when the plugin started (e.g. after an in-place update)
      // never re-dispatch renderToolbar: their section is empty or still holds the previous
      // version's buttons (wired to unloaded code). Draw a fresh toolbar into each.
      for (const reader of Zotero.Reader._readers || []) {
        if (reader.type !== "pdf") continue;
        renderIntoOpenReader(reader);
        DeepRead.Session.forReader(reader)?.init();
      }
    },

    /** Plugin shutdown: take our buttons out of open readers (Zotero only drops the listener). */
    unregister() {
      for (const close of [...activeMenus]) close({ restoreFocus: false });
      for (const reader of Zotero.Reader._readers || []) {
        const doc = reader._iframeWindow?.document;
        if (!doc) continue;
        removeToolbars(doc);
        doc.getElementById("deepread-toolbar-css")?.remove();
      }
    },
  };

  function removeToolbars(doc) {
    openMenus.get(doc)?.({ restoreFocus: false });
    for (const node of doc.querySelectorAll(".deepread-toolbar")) {
      const section = node.parentNode;
      node.remove();
      if (section?.classList?.contains("section") && !section.childNodes.length) section.remove();
    }
  }

  /** Same as Zotero's CustomSections append for the toolbar ("div.end > div.custom-sections"). */
  function renderIntoOpenReader(reader) {
    try {
      const win = reader._iframeWindow;
      const doc = (win?.wrappedJSObject || win)?.document;
      if (!doc) return;
      const sections = doc.querySelector(".toolbar .end > .custom-sections") || doc.querySelector(".end > .custom-sections");
      if (!sections) return; // toolbar not mounted yet: it will dispatch renderToolbar itself
      removeToolbars(doc);
      doc.getElementById("deepread-toolbar-css")?.remove(); // may be an older version's styles
      render({
        reader,
        doc,
        append: (...nodes) => {
          const section = doc.createElement("div");
          section.className = "section";
          section.append(...nodes);
          sections.append(section);
        },
      });
    }
    catch (e) {
      DeepRead.log("toolbar render into open reader failed", e?.stack || String(e));
    }
  }
})();

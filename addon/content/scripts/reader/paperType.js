/* Translated prose uses the same local fonts in the PDF reader and print frame.
 * License: AGPL-3.0-or-later. */
(function () {
  const documents = new WeakMap();
  const css = "chrome://deepread/content/styles/paper.css";
  function install(doc) {
    let state = documents.get(doc);
    if (state?.link.isConnected) return state;
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    link.rel = "stylesheet";
    link.href = css;
    state = { link, loads: new Map() };
    state.sheet = new Promise(resolve => {
      state.finish = resolve;
      link.onload = link.onerror = resolve;
    });
    documents.set(doc, state);
    (doc.head || doc.documentElement).append(link);
    return state;
  }

  function remove(doc) {
    const state = documents.get(doc);
    if (!state) return;
    state.finish();
    state.link.remove();
    documents.delete(doc);
  }

  function ready(doc, language) {
    const state = install(doc);
    const simplified = /^(?:zh|zh-CN|zh-Hans)$/i.test(language);
    if (!state.loads.has(simplified)) {
      const loading = state.sheet.then(() => {
        const styles = ["normal", "bold", "italic", "italic bold"];
        const loads = styles.map(style => doc.fonts.load(style + ' 12px "DeepRead Roman"', "Aa1"));
        if (simplified) for (const style of styles) loads.push(doc.fonts.load(style + ' 12px "DeepRead Song"', "论文"));
        return Promise.all(loads);
      }).catch(error => DeepRead.log("paper font unavailable; using the local fallback", String(error)));
      state.loads.set(simplified, loading);
    }
    return state.loads.get(simplified);
  }

  function apply(node, language) {
    node.lang = language === "zh" ? "zh-CN" : language;
    node.classList.add("dr-paper");
  }

  // A full-width stop already provides its own sidebearing. Keep deliberate
  // Western word spaces and add a thin space where two scripts touch.
  function spaceChinese(fragment) {
    let nodes = [];
    function finish() {
      if (!nodes.length) return;
      // Treat an inline formula as a single glyph for boundary spacing. Its
      // contents, baseline and accessible label belong to the math renderer.
      const text = nodes.map(n => n.nodeType===3 ? n.data : "\uFFFC").join("");
      const gaps = text.matchAll(/(?<=[\p{Script=Han}。，、！？：；“”‘’《》（）【】]) +(?=[\p{Script=Han}。，、！？：；“”‘’《》（）【】])/gu);
      const remove = new Set();
      for (const gap of gaps) for (let i = 0; i < gap[0].length; i++) remove.add(gap.index + i);
      const boundaries = text.matchAll(/(?<=\p{Script=Han})[ \u2009]*(?=[\p{Script=Latin}0-9\uFFFC])|(?<=[\p{Script=Latin}0-9%\uFFFC])[ \u2009]*(?=\p{Script=Han})/gu);
      const insert = new Set();
      for (const gap of boundaries) {
        insert.add(gap.index);
        for (let i=0;i<gap[0].length;i++) remove.add(gap.index+i);
      }
      if (remove.size || insert.size) {
        let offset = 0;
        for (const node of nodes) {
          if (node.nodeType!==3) {
            if (insert.has(offset)) node.before("\u2009");
            offset++;
            continue;
          }
          const original = node.data;
          let cleaned = "";
          for (let i = 0; i < original.length; i++, offset++) {
            if (insert.has(offset)) cleaned += "\u2009";
            if (!remove.has(offset)) cleaned += original[i];
          }
          if (cleaned !== original) node.data = cleaned;
        }
      }
      nodes = [];
    }
    function visit(node) {
      if (node.nodeType === 3) { nodes.push(node); return; }
      if (node.matches?.("code, pre, a, .katex-display, math[display=block], .dr-paper-code, .dr-list-marker")) { finish(); return; }
      if (node.matches?.("math, .katex, [role=math]")) { nodes.push(node); return; }
      const boundary = node.nodeType === 1 && !["span","em","strong","b","i"].includes(node.localName);
      if (boundary) finish();
      for (const child of node.childNodes) visit(child);
      if (boundary) finish();
    }
    visit(fragment);
    finish();
  }

  function separateLead(fragment, source) {
    const label=/^(\*{1,3})([^*\n]+)\1\s+(?=[\p{L}⟦])/u.exec(source || "");
    if (!label || label[2].length>60 || /[.!?;:，。！？；：]$/u.test(label[2].trim())) return;
    const host=fragment.firstElementChild?.localName==="p" ? fragment.firstElementChild : fragment;
    const lead=[...host.childNodes].find(node=>node.textContent.trim());
    if (!["em","strong"].includes(lead?.localName) || !/\p{Script=Han}$/u.test(lead.textContent)) return;
    const next=lead.nextSibling;
    if (next && /^\p{Script=Han}/u.test(next.textContent)) lead.after("\u2002");
  }

  DeepRead.PaperType = { install, remove, ready, apply, spaceChinese, separateLead };
})();

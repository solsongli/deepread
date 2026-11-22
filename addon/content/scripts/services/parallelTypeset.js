/* Zotero adapter for RetainPDF's UAX #14 line breaker and collision-constrained font search.
 * Upstream versions and MIT notices are in NOTICE.md and content/lib/retainpdf/rendering/.
 * License (adapter): AGPL-3.0-or-later */
(function () {
  let rendering;
  function engine() {
    if (!rendering) {
      const scope = {};
      for (const file of ["uax14-data.js", "linebreak.js", "rects.js"]) {
        Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/retainpdf/rendering/${file}`, scope);
      }
      rendering = scope.RetainPdfRendering;
    }
    return rendering;
  }
  const h = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);

  function styledRuns(node, runs, bold, italic) {
    if (node.nodeType === 3) {
      if (node.nodeValue) runs.push({ text: node.nodeValue, bold, italic });
      return;
    }
    for (const child of node.childNodes) styledRuns(child, runs, bold || ["strong", "b"].includes(node.localName), italic || ["em", "i"].includes(node.localName));
  }

  // Keep the original run styles when an engine line break cuts through an emphasis span.
  function makeLine(doc, runs, start, end) {
    const line = h(doc, "div");
    line.className = "dr-parallel-line";
    for (const r of runs) {
      if (r.end <= start) continue;
      if (r.start >= end) break;
      const slice = r.text.slice(Math.max(0, start - r.start), Math.min(r.text.length, end - r.start));
      let part = doc.createTextNode(slice);
      for (const tag of [r.italic && "em", r.bold && "strong"]) {
        if (tag) { const mark = h(doc, tag); mark.append(part); part = mark; }
      }
      line.append(part);
    }
    return line;
  }

  function draw(box, unit, fragment, sourceSize) {
    const doc = box.ownerDocument, api = engine();
    const original = Math.max(1, sourceSize);
    const marker = unit.marker ? unit.marker + " " : "";
    const runs = [];
    if (marker) runs.push({ text: marker, bold: false, italic: false });
    const rich = !!fragment.querySelector(":not(p,strong,em,b,i)") || /[\uFFFC\u2028\n]/.test(fragment.textContent.trim());
    styledRuns(fragment, runs, unit.title, false);
    while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
    if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
    let text = "";
    for (const r of runs) {
      r.start = text.length; text += r.text; r.end = text.length;
    }
    const family = doc.defaultView.getComputedStyle(box).fontFamily;
    const measure = h(doc, "canvas").getContext("2d");
    const breaker = api.TextLinebreak;
    // Use actual locally available serif faces (also for CJK fallback), measured in em.
    const prepared = !rich && breaker.prepare([{ type: "text", value: text }], {
      ascender: 0.82, descender: 0.18,
      shape(value) {
        const advances = new Float64Array(value.length);
        for (const r of runs) {
          measure.font = `${r.italic ? "italic" : "normal"} ${r.bold ? "bold" : "normal"} 100px ${family}`;
          let offset = r.start;
          for (const ch of r.text) { advances[offset] = measure.measureText(ch).width / 100; offset += ch.length; }
        }
        return advances;
      },
    });
    const lineRatio = Math.min(1.45, Math.max(1.05, unit.pitch || 1.18));
    const width = parseFloat(box.style.width);
    function paint(size, ratio) {
      box.style.fontSize = `${size}px`;
      box.style.lineHeight = String(ratio);
      if (prepared) {
        const indent = (unit.indent || 0) * size;
        const hang = marker ? Math.max(1.1, unit.hanging || 0) * size : 0;
        const result = breaker.layout(prepared, size, width, { indent, hang });
        const rows = result.lines.filter((line) => line.end > line.start).map((range, i) => {
          const line = makeLine(doc, runs, range.start, range.end);
          line.style.paddingInlineStart = `${i ? hang : indent}px`;
          if (unit.justified && i < result.lines.length - 1) {
            const gaps = breaker.justifiableGaps(prepared, range.start, range.end);
            const left = i ? hang : 0;
            if (gaps && width - left - range.width <= gaps * size * 0.25) line.style.textAlignLast = "justify";
          }
          return line;
        });
        box.replaceChildren(...rows);
      }
      else if (!box.firstChild) {
        if (marker) box.append(marker);
        box.append(fragment);
        box.style.textIndent = `${unit.indent || 0}em`;
      }
      return box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
    }
    let fits = paint(original, lineRatio);
    if (!fits) {
      const ratio = Math.min(lineRatio, 1.08);
      const lower = Math.max(original * 0.82, Math.min(original, 7));
      const minFits = paint(lower, ratio);
      const { value } = minFits ? api.FitModelParts.rects.gallopingGrow(lower, original, 0.125, (size) => !paint(size, ratio)) : { value: lower };
      fits = paint(value, ratio);
    }
    if (!fits) {
      // Full accessible text stays within the source box even for verbose translations.
      box.dataset.overflow = "true"; box.tabIndex = 0;
      box.title = DeepRead.bilingual("译文较长，可在段内滚动", "Scroll within this paragraph for its full translation");
    }
  }
  DeepRead.ParallelTypeset = { engine, draw };
})();

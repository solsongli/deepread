/* Zotero typesetting adapter for the RetainPDF line breaker and bounded font search.
 * Upstream versions and MIT notices are in NOTICE.md. Adapter: AGPL-3.0-or-later. */
(function () {
  let rendering;
  function engine() {
    if (!rendering) {
      const scope = {};
      for (const file of ["uax14-data.js", "linebreak.js", "rects.js"])
        Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/retainpdf/rendering/${file}`, scope);
      rendering = scope.RetainPdfRendering;
    }
    return rendering;
  }
  const h = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);

  function collect(node, runs, style) {
    if (node.nodeType === 3) {
      if (node.nodeValue) runs.push({ ...style, text: node.nodeValue });
      return;
    }
    if (node.classList?.contains("dr-parallel-atom")) {
      const { widthEm, heightEm, depthEm } = node.dataset;
      runs.push({
        node,
        text: "\uFFFC",
        widthEm: Number(widthEm),
        heightEm: Number(heightEm),
        depthEm: Number(depthEm)
      });
      return;
    }
    const next = {
      bold: style.bold || ["strong", "b"].includes(node.localName),
      italic: style.italic || ["em", "i"].includes(node.localName),
      mono: style.mono || node.classList?.contains("dr-paper-code"),
      color: node.style?.color || style.color,
      link: node.dataset?.sourceLink ?? style.link
    };
    for (const child of node.childNodes) collect(child, runs, next);
  }

  function preparedRuns(doc, fragment, unit, style) {
    const runs = [];
    collect(fragment, runs, { bold: unit.title && unit.boldTitle, italic: unit.allItalic });
    while (runs.length && !runs.at(-1).text.trim()) runs.pop();
    if (runs.length) runs.at(-1).text = runs.at(-1).text.trimEnd();
    const engineText = engine().TextLinebreak;
    const ctx = h(doc, "canvas").getContext("2d"),
      segments = [],
      textChunks = [];
    let index = 0,
      widths = [];
    // The engine shapes one text chunk between each pair of inline objects.
    // UTF-16 offsets remain valid across run boundaries and surrogate pairs.
    for (const r of runs) {
      r.start = index;
      index += r.text.length;
      r.end = index;
      if (r.node) {
        if (widths.length) {
          textChunks.push(widths);
          widths = [];
        }
        segments.push({ type: "math", widthEm: r.widthEm, heightEm: r.heightEm, depthEm: r.depthEm });
      } else {
        segments.push({ type: "text", value: r.text });
        const family=r.mono ? style.getPropertyValue("--dr-paper-code").trim() || "monospace" : style.fontFamily;
        ctx.font = `${r.italic ? "italic" : "normal"} ${r.bold ? "bold" : style.fontWeight} 100px ${family}`;
        for (const ch of r.text) {
          widths.push(ctx.measureText(ch).width / 100);
          if (ch.length === 2) widths.push(0);
        }
      }
    }
    if (widths.length) textChunks.push(widths);
    let chunk = 0;
    const prepared = engineText.prepare(segments, {
      ascender: 0.82,
      descender: 0.18,
      shape: () => textChunks[chunk++]
    });
    return { runs, prepared };
  }

  function makeLine(doc, runs, start, end) {
    const line = h(doc, "div");
    line.className = "dr-parallel-line";
    const ink = h(doc, "span");
    ink.className = "dr-parallel-line-ink";
    line.append(ink);
    for (const r of runs) {
      if (r.end <= start) continue;
      if (r.start >= end) break;
      if (r.node) {
        ink.append(r.node);
        continue;
      }
      let part = doc.createTextNode(
        r.text.slice(Math.max(0, start - r.start), Math.min(r.text.length, end - r.start))
      );
      if (r.bold) {
        const mark = h(doc, "strong");
        mark.append(part);
        part = mark;
      }
      if (r.italic) {
        const mark = h(doc, "em");
        mark.append(part);
        part = mark;
      }
      if (r.color || r.link != null || r.mono) {
        const span = h(doc, r.link != null ? "a" : "span");
        if(r.mono)span.classList.add("dr-paper-code");
        if (r.color) span.style.color = r.color;
        if (r.link != null) {
          span.href = "#";
          span.dataset.sourceLink = r.link;
        }
        span.append(part);
        part = span;
      }
      ink.append(part);
    }
    return line;
  }

  function justifyChinese(content, width, firstInset, nextInset, size) {
    const doc = content.ownerDocument;
    for (const [i, row] of [...content.children].slice(0, -1).entries()) {
      const ink = row.firstChild,
        slack = width - (i ? nextInset : firstInset) - ink.offsetWidth;
      if (slack < 1 || slack > size * 1.35) continue;
      const walker = doc.createTreeWalker(ink, 4),
        runs = [];
      let count = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest("a, code, .dr-paper-code, [role=math]")) continue;
        const matches = [...node.data.matchAll(/\p{Script=Han}{2,}/gu)];
        if (matches.length) runs.push({ node, matches });
        for (const m of matches) count += [...m[0]].length - 1;
      }
      if (count < 5 || slack / count > size * 0.075) continue;
      const spacing = (slack - 0.6) / count;
      const touched = [];
      for (const { node, matches } of runs) {
        const frag = doc.createDocumentFragment();
        let start = 0;
        for (const m of matches) {
          const chars = [...m[0]],
            last = chars.pop(),
            span = h(doc, "span");
          span.style.letterSpacing = spacing + "px";
          span.textContent = chars.join("");
          frag.append(node.data.slice(start, m.index), span, last);
          touched.push(span);
          start = m.index + m[0].length;
        }
        frag.append(node.data.slice(start));
        node.replaceWith(frag);
      }
      if (ink.offsetWidth + (i ? nextInset : firstInset) > width + 0.5)
        for (const span of touched) span.style.letterSpacing = "";
    }
  }

  function inlineMath(box, fragment, type, ascent) {
    const doc=box.ownerDocument;
    // Use the same atom representation for OCR TeX and native PDF glyph crops.
    for (const math of fragment.querySelectorAll(".katex, math")) {
      if (math.parentElement?.closest(".katex, .dr-parallel-atom, .katex-display") || math.getAttribute("display")==="block") continue;
      const atom=h(doc,"span"), measure=h(doc,"span"), probe=h(doc,"span"), inner=h(doc,"span");
      atom.className="dr-parallel-atom"; atom.setAttribute("role","math");
      measure.style.cssText="position:absolute;visibility:hidden;white-space:nowrap;line-height:0";
      probe.style.cssText="display:inline-block;width:0;height:0;vertical-align:baseline";
      inner.style.cssText="display:inline-block;vertical-align:baseline;line-height:normal";
      math.replaceWith(atom);inner.append(math);measure.append(probe,inner);box.append(measure);
      const bounds=inner.getBoxQuads({relativeTo:measure})[0]?.getBounds();
      const base=probe.getBoxQuads({relativeTo:measure})[0]?.p1.y;
      if (bounds?.height>0 && Number.isFinite(base)) {
        const height=bounds.height/type.size, depth=Math.max(0,(bounds.bottom-base)/type.size);
        Object.assign(atom.dataset,{widthEm:bounds.width/type.size,heightEm:height,depthEm:Math.min(height,depth)});
        inner.removeAttribute("style");inner.className="dr-typeset-math";
        atom.append(inner);
      } else atom.replaceWith(math);
      measure.remove();
    }
    for (const atom of fragment.querySelectorAll(".dr-parallel-atom")) {
      const w=Number(atom.dataset.widthEm),h=Number(atom.dataset.heightEm),d=Number(atom.dataset.depthEm);
      const factor=Math.min(1,ascent/(Math.max(.001,h-d)*type.size),(type.step-ascent)/(Math.max(.001,d)*type.size));
      Object.assign(atom.dataset,{widthEm:w*factor,heightEm:h*factor,depthEm:d*factor});
      Object.assign(atom.style,{width:w*factor+"em",height:h*factor+"em",verticalAlign:-d*factor+"em"});
      if (atom.firstChild?.classList?.contains("dr-typeset-math")) atom.firstChild.style.fontSize=factor+"em";
    }
  }

  function fitMath(box,fragment,type,scale=1) {
    const size=type.size*scale, step=type.step*scale;
    inlineMath(box,fragment,{size,step},.84*size+.24*(step-size));
  }

  function markOverflow(box) {
    box.dataset.overflow="true"; box.tabIndex=0;
    box.title=DeepRead.bilingual("译文较长，可在段内滚动","Scroll within this paragraph for its full translation");
  }

  function draw(box, unit, fragment, sourceSize, type = null) {
    const doc = box.ownerDocument,
      api = engine(),
      original = type?.size || Math.max(1, sourceSize);
    let width = parseFloat(box.style.width);
    const height = parseFloat(box.style.height);
    const ascent=type ? .84*original+.24*(type.step-original) : 0;
    if (type) {
      DeepRead.PaperStyles.apply(box,type);
      inlineMath(box,fragment,type,ascent);
      for (const number of fragment.querySelectorAll(".dr-parallel-heading-number")) {
        number.style.width="";number.after("\u2002");
      }
      if (type.weight===700) {
        for (const mark of fragment.querySelectorAll("em,i")) if (!mark.closest("[role=math]")) mark.replaceWith(...mark.childNodes);
      }
    }
    const style = doc.defaultView.getComputedStyle(box);
    const simple =
      (!type || fragment.querySelectorAll("p").length<2) &&
      ![...fragment.querySelectorAll("*")].some(
        (el) =>
          !el.closest(".dr-parallel-atom") && !["p", "span", "a", "strong", "em", "b", "i"].includes(el.localName)
      ) && !/[\uFFFC\u2028\n]/.test(fragment.textContent.trim());
    const content = h(doc, "div");
    content.className = "dr-parallel-copy";
    let marker;
    if (unit.marker) {
      marker = h(doc, "span");
      marker.className = "dr-parallel-marker";
      marker.textContent = unit.marker;
      if (unit.markerRect && !type) marker.style.opacity = "0";
      box.append(marker);
    }
    box.append(content);
    const markerInset = unit.marker ? (unit.markerIndent ?? (unit.hanging || 1.2)) * original : 0;
    const nextInset = unit.marker
      ? (unit.hanging || unit.markerIndent || 1.2) * original
      : unit.role === "ref_text"
        ? unit.hanging * original
        : 0;
    const firstInset = unit.marker ? markerInset : (unit.indent || 0) * original;
    const sourceLines = unit.rects?.length || 1;
    let headingSize = original;
    if (!type && unit.documentTitle && unit.titleInsets && simple && /^zh(?:-|$)/i.test(box.lang)) {
      const measured = h(doc, "span");
      measured.className = "dr-parallel-line-ink";
      measured.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:" + original + "px";
      measured.append(fragment.cloneNode(true));
      box.append(measured);
      const advance = measured.offsetWidth;
      measured.remove();
      const sourceAdvance = (unit.rects.reduce((sum, r) => sum + r[2] - r[0], 0) * original) / unit.size;
      if (advance > 0)
        headingSize =
          original *
          Math.max(
            1,
            Math.min(
              sourceLines > 1 ? 1.36 : 1.1,
              (0.93 * sourceAdvance) / advance,
              height / (sourceLines === 1 ? 0.96 : 1 + (sourceLines - 1) * 1.17) / original
            )
          );
    }
    if (!type && (unit.title || unit.centered) && simple && sourceLines === 1) {
      const line = h(doc, "div"),
        ink = h(doc, "span");
      line.className = "dr-parallel-line";
      ink.className = "dr-parallel-line-ink";
      line.style.paddingInlineStart = firstInset + "px";
      line.append(ink);
      ink.append(fragment);
      content.append(line);
      const number = ink.querySelector(".dr-parallel-heading-number");
      if (number?.nextSibling?.nodeType === 3)
        number.nextSibling.nodeValue = number.nextSibling.nodeValue.trimStart();
      box.style.fontSize = headingSize + "px";
      box.style.lineHeight = height + "px";
      // One line of Latin headings often has a glyph box shorter than its em.
      // Keep its actual font size and number-to-title gap when the title fits.
      if (ink.offsetWidth + firstInset <= width + 0.5) {
        if (unit.title) box.classList.add("dr-parallel-heading");
        if (unit.centered) line.style.textAlign = "center";
        return;
      }
      if (number) {
        number.classList.remove("dr-parallel-heading-number");
        number.after(" ");
      }
      fragment.append(...ink.childNodes);
      content.replaceChildren();
    }
    const material = simple ? preparedRuns(doc, fragment, unit, style) : null;
    if (!simple) content.append(fragment);
    const cjkBody =
      !unit.title && !unit.caption && /\p{Script=Han}/u.test(material?.prepared.text || content.textContent);
    const sourcePitch = Math.min(
      1.5,
      Math.max(1.05, (unit.caption || unit.title ? unit.pitch : unit.bodyPitch) || 1.2)
    );
    // Keep the common baseline grid while matching the text size of a printed
    // column. A shorter translation leaves space at the end of its source frame.
    const bodyScale = /^zh(?:-|$)/i.test(box.lang) ? 1.02 : 1.12;
    const preferredSize = cjkBody ? original * bodyScale : headingSize;
    const standardStep = Math.max(
      original * (cjkBody ? Math.max(sourcePitch, 1.5) : sourcePitch),
      unit.documentTitle ? headingSize * 1.17 : 0
    );
    // Tight frames have one second, shared baseline step. Font fitting never
    // redistributes leftover height across an individual paragraph.
    const compactStep = Math.min(standardStep, original * Math.max(1.14, sourcePitch));

    let dimensions;
    function paint(size, requestedStep) {
      box.style.fontSize = size + "px";
      box.style.lineHeight = requestedStep + "px";
      if (!material) {
        content.style.paddingInlineStart = nextInset + "px";
        content.style.textIndent = firstInset - nextInset + "px";
        const natural=content.offsetHeight;
        dimensions={height:natural,inkHeight:natural,wide:content.scrollWidth>width+1};
        return !dimensions.wide && natural<=height+.5;
      }

      let measureWidth = width,
        rows = [],
        excess = 0;
      if (unit.title && unit.centered && sourceLines > 1 && sourceLines <= 3) {
        // Balance the Chinese title across the source's line count, keeping
        // complete Western words and the original heading size.
        let lo = (width / sourceLines) * 0.65,
          hi = width;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          const count = api.TextLinebreak.layout(material.prepared, size, mid, { indent: 0, hang: 0 }).lines.length;
          if (count > sourceLines) lo = mid;
          else hi = mid;
        }
        measureWidth = Math.min(width, hi + size * 0.4);
      }
      for (let pass = 0; pass < (type ? 8 : 4); pass++) {
        const { lines } = api.TextLinebreak.layout(material.prepared, size, measureWidth, {
          indent: firstInset,
          hang: nextInset
        });
        rows = lines
          .filter((l) => l.end > l.start)
          .map((range, i) => {
            let end = range.end;
            while (end > range.start && /\s/u.test(material.prepared.text[end - 1])) end--;
            const row = makeLine(doc, material.runs, range.start, end);
            const ink = row.firstChild;
            ink.style.left = (i ? nextInset : firstInset) + "px";
            row.classList.add("dr-parallel-grid-line");
            // A zero-height inline box exposes the actual Gecko baseline, even
            // when an adjacent original formula has an unusually tall exponent.
            const probe = h(doc, "span");
            probe.className = "dr-parallel-baseline";
            probe.setAttribute("aria-hidden", "true");
            ink.prepend(probe);
            return row;
          });
        content.replaceChildren(...rows);
        excess = Math.max(
          0,
          ...rows.map((row, i) => row.firstChild.offsetWidth + (i ? nextInset : firstInset) - width)
        );
        if (excess <= 0.6 || !rows.length || measureWidth <= width * 0.7) break;
        measureWidth = Math.max(width * 0.7, measureWidth - excess - (type ? Math.max(size*.5,1) : 1));
      }
      const extents = rows.map((row) => {
        let above = size * 0.84,
          below = size * 0.14;
        for (const atom of row.querySelectorAll(".dr-parallel-atom")) {
          const depth = Number(atom.dataset.depthEm),
            height = Number(atom.dataset.heightEm);
          above = Math.max(above, (height - depth) * size);
          below = Math.max(below, depth * size);
        }
        return { above, below };
      });
      const first = type ? ascent : extents[0]?.above || 0,
        last = extents.at(-1)?.below || 0;
      // Extra clearance is needed only when two consecutive lines really have
      // protruding ink. Apply it to the entire block so all baselines stay even.
      let step = requestedStep;
      if (!type) for (let i = 1; i < extents.length; i++) step = Math.max(step, extents[i - 1].below + extents[i].above);
      const occupied = first + Math.max(0, rows.length - 1) * step + last;
      const baselines = rows.map((row) => {
        const ink = row.firstChild,
          probe = ink.firstChild;
        // offsetTop rounds to whole CSS pixels and creates a visible step
        // after zooming. Gecko's local coordinates retain fractional baselines.
        return probe.getBoxQuads({ relativeTo: ink })[0].p1.y;
      });
      rows.forEach((row, i) => {
        row.style.height = (i + 1 === rows.length ? first + last : step) + "px";
        row.firstChild.style.top = first - baselines[i] + "px";
        if (unit.centered) row.firstChild.style.left = Math.max(0, (width - row.firstChild.offsetWidth) / 2) + "px";
      });
      dimensions={height:rows.length*step,inkHeight:occupied,wide:excess>1,excess,
        lines:rows.map((row,i)=>({left:i===0 && marker ? 0 : parseFloat(row.firstChild.style.left)||0,
          top:i*step,width:row.firstChild.offsetWidth+(i===0 && marker ? firstInset : 0),
          height:first+extents[i].below}))};
      return !dimensions.wide && occupied<=height+.4;
    }
    if (type) {
      const rewrap=newWidth=>{
        width=newWidth;box.style.width=width+"px";
        paint(type.size,type.step);
        if (material && cjkBody && type.role==="body" && !unit.centered) justifyChinese(content,width,firstInset,nextInset,type.size);
        return {...dimensions,rewrap};
      };
      return rewrap(width);
    }
    let fits = paint(preferredSize, standardStep);
    if (!fits && cjkBody && paint(original, standardStep)) {
      const chosen = api.FitModelParts.rects.gallopingGrow(
        original,
        preferredSize,
        0.125,
        (v) => !paint(v, standardStep)
      ).value;
      fits = paint(chosen, standardStep);
    }
    if (!fits) {
      const floor = unit.verifiedLabel ? original * 0.78 : Math.max(original * 0.82, Math.min(original, 7));
      fits = paint(preferredSize, compactStep);
      if (!fits) {
        const minFits = paint(floor, compactStep);
        const chosen = minFits
          ? api.FitModelParts.rects.gallopingGrow(floor, preferredSize, 0.125, (v) => !paint(v, compactStep)).value
          : floor;
        fits = paint(chosen, compactStep);
      }
    }
    if (fits && material && cjkBody && unit.justified && !unit.centered) {
      justifyChinese(content, width, firstInset, nextInset, parseFloat(box.style.fontSize));
    }
    if (!fits) markOverflow(box);
  }
  DeepRead.ParallelTypeset = { engine, draw, fitMath, markOverflow };
})();

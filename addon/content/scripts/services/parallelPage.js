/* Map translated source units to physical PDF frames for the facing-page reader.
 * License: AGPL-3.0-or-later */
(function () {
  const visual = new Set(["image", "figure", "chart", "table"]);
  const protectedTypes = new Set([...visual, "equation", "interline_equation", "formula", "code", "code_block"]);
  const prose = new Set(["text", "title", "list", "text_with_equation", "ref_text", "header", "footer", "footnote", "page_footnote", "caption", "algorithm_step", "table_label", "figure_label", "formula_note", "code_comment"]);
  const normalized = text => DeepRead.ParallelInline.geometryText(text);
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1];
  const union = (rects) => rects.length ? DeepRead.Overlay.unionRect(rects) : null;
  const glyphText = (c) => c.u ?? c.c ?? "";

  function fromPermille(rect, view) {
    if (!valid(rect)) return null;
    const w = (view[2] - view[0]) / 1000, h = (view[3] - view[1]) / 1000;
    return [view[0] + rect[0] * w, view[3] - rect[3] * h, view[0] + rect[2] * w, view[3] - rect[1] * h];
  }

  function inside(rect, x, y, pad = 0) {
    return rect && x >= rect[0] - pad && x <= rect[2] + pad && y >= rect[1] - pad && y <= rect[3] + pad;
  }

  function charactersIn(rect, chars) {
    if (!rect) return [];
    return chars.filter((c) => valid(c.rect) && inside(rect, (c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2, 1));
  }

  function match(chars, source) {
    const needle = normalized(source);
    if (!needle) return [];
    const printed = normalized(chars.map(glyphText).join(""));
    if (printed === needle) return chars;
    const exact = DeepRead.Typography.match(chars, source);
    if (exact) return exact;
    // PDF accents and inline TeX often differ in their Unicode spelling. Only
    // take the entire *bounded* run when both ends and its internal text agree.
    if (
      needle.length < 24 ||
      Math.abs(printed.length - needle.length) > Math.max(4, needle.length * 0.1) ||
      !printed.startsWith(needle.slice(0, 5)) ||
      !printed.endsWith(needle.slice(-5))
    )
      return [];
    const chunks = new Map();
    for (let i = 0; i + 4 <= printed.length; i++) {
      const q = printed.slice(i, i + 4);
      chunks.set(q, (chunks.get(q) || 0) + 1);
    }
    let common = 0;
    for (let i = 0; i + 4 <= needle.length; i++) {
      const q = needle.slice(i, i + 4),
        count = chunks.get(q) || 0;
      if (count) {
        common++;
        chunks.set(q, count - 1);
      }
    }
    return (2 * common) / (printed.length + needle.length - 6) >= 0.86 ? chars : [];
  }

  function glyphStream(chars) {
    let text = "";
    const mapping = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const run = glyphText(c) + (c.lineBreakAfter || c.paragraphBreakAfter ? "\n" : c.spaceAfter ? " " : "");
      text += run;
      for (let j = 0; j < run.length; j++) mapping.push(i);
    }
    return { text, mapping };
  }

  function linesOf(chars) {
    const rects = [];
    let line = [];
    for (const c of chars) {
      if (valid(c.rect) && glyphText(c).trim()) {
        const last = line.at(-1);
        const height = last && Math.max(last[3] - last[1], c.rect[3] - c.rect[1], c.fontSize || 0);
        const scriptOnLine = last && c.rect[0] >= last[2] - height * 0.2 && c.rect[0] < last[2] + height &&
          c.rect[1] <= last[3] + height * 0.15 && c.rect[3] >= last[1] - height * 0.15;
        if (last && !scriptOnLine && !c.scriptContinuation && Math.abs(c.rect[1] - line[0][1]) > Math.max(2, height * 0.65)) {
          rects.push(union(line)); line = [];
        }
        line.push(c.rect);
      }
      if (line.length && (c.lineBreakAfter || c.paragraphBreakAfter)) { rects.push(union(line)); line = []; }
    }
    if (line.length) rects.push(union(line));
    return rects;
  }

  function firstBaseline(chars, line, size) {
    if (!line) return;
    // A superscript or an inline fraction may precede the first word.
    // Use normal-size glyphs on this physical line to recover its writing baseline.
    const values = chars
      .filter(
        (c) =>
          valid(c.rect) &&
          Number.isFinite(c.baseline) &&
          c.fontSize >= size * 0.84 &&
          c.fontSize <= size * 1.2 &&
          inside(line, (c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2, 0.25)
      )
      .map((c) => c.baseline)
      .sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  function markerLength(chars, marker) {
    if (!marker) return 0;
    let i = 0, prefix = "";
    while (i < chars.length && prefix.length < marker.length) prefix += glyphText(chars[i++]).trim();
    if (prefix !== marker) return 0;
    while (i < chars.length && !glyphText(chars[i]).trim()) i++;
    return i;
  }

  function withoutMarker(text, marker) {
    if (!marker || !text) return text;
    const prefix = text.match(/^\s*\*{0,3}/u)[0];
    const bare = text.slice(prefix.length);
    return bare.startsWith(marker) ? prefix + bare.slice(marker.length).trimStart() : text;
  }

  function sourceParagraph(item, i) {
    let text = item.text;
    if (visual.has(item.type))
      text = item.captionFrames?.length ? [] : item.image_caption || item.table_caption || item.chart_caption || [];
    else if (item.type === "list") text = item.list_items;
    if (Array.isArray(text)) text = text.filter((x) => typeof x === "string").join("\n\n");
    return {
      paragraphText: typeof text === "string" ? text.trim() : "",
      paragraphIndex: i,
      minerUid: item.id ?? `item:${i}`,
      paragraphType: item.text_level > 0 ? "title" : item.type,
      headingLevel:item.text_level, layoutPart:item.layoutPart,
      bbox: item.bbox,
      context: item.context,
      inlineGlyphs: item.inlineGlyphs,
      visualOwner: item.visualOwner,
      flushLeft: item.flushLeft,
      pageIndex: item.page_idx,
      docTitle: item.text_level === 1 && item.page_idx === 0
    };
  }

  function joinSplitFormula(sources, chars, view) {
    const output = [];
    for (const p of sources) {
      const prev = output.at(-1);
      if (!prev || prev.paragraphType !== "text" || p.paragraphType !== "text" ||
          !/^\s*(?:[A-Za-z]\s*[=<>≤≥]|[_^=])/u.test(p.paragraphText)) {
        output.push(p);
        continue;
      }
      const box = fromPermille(prev.bbox, view), next = fromPermille(p.bbox, view);
      if (!box || !next || next[3] < box[1] || next[1] > box[3]) { output.push(p); continue; }
      const left = match(charactersIn(box, chars), prev.paragraphText);
      const right = match(charactersIn(next, chars), p.paragraphText);
      const tail = left.at(-1), head = right[0];
      const a = chars.indexOf(tail), b = chars.indexOf(head);
      const em = Math.max(tail?.fontSize || 0, head?.fontSize || 0);
      if (a < 0 || b <= a || b-a > 4 || chars.slice(a+1,b).some(c=>glyphText(c).trim()) ||
          Math.abs(tail.rect[2]-head.rect[0]) > em*3 || Math.abs(tail.rect[1]-head.rect[1]) > em*1.8) {
        output.push(p);
        continue;
      }
      // MinerU can end a box with the superscript and start the next with the
      // subscript of the very same formula. Join only adjacent physical glyphs.
      const glyphs = [...left.slice(0,-1), {...tail, lineBreakAfter:false, paragraphBreakAfter:false, spaceAfter:false}, ...right];
      output[output.length-1] = { paragraphType:"text", paragraphText:prev.paragraphText+" "+p.paragraphText,
        minerUid:prev.minerUid, bbox:union([prev.bbox,p.bbox]), inlineGlyphs:glyphs };
    }
    return output;
  }

  function equationTag(chars) {
    const end = chars.findIndex(c => c.lineBreakAfter || c.paragraphBreakAfter);
    if (end < 1 || end > 12 || end+1 >= chars.length) return null;
    const first = chars.slice(0,end+1);
    const label = first.map(glyphText).join("").trim();
    if (!/^\(\s*\d+[a-z]?\s*\)$/iu.test(label)) return null;
    const following = chars[end+1], size = following.fontSize || 10;
    if (!following.rect || first[0].rect[0] < following.rect[0]+size*4 ||
        first[0].rect[1] < following.rect[1]+size*.55) return null;
    return {label, end:end+1, rect:union(first.map(c=>c.rect).filter(valid))};
  }

  function uncoveredHeadings(sources, chars, view, tableBounds) {
    const frames=sources.map(p=>fromPermille(p.bbox,view) || union((p.rects || []).filter(valid))).filter(valid);
    for (const bbox of tableBounds || []) frames.push(fromPermille(bbox,view));
    if (!frames.length) return [];
    const result=[];
    let line=[];
    function finish() {
      const text=glyphStream(line).text.trim();
      if (!/^(?:[IVXLCDM]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\p{Lu}/u.test(text) ||
          text.length>120 || !/[a-z]{3}/iu.test(text) || /[!?;:]$/u.test(text)) return;
      const rect=union(line.map(c=>c.rect)), size=Math.max(...line.map(c=>c.fontSize || 0));
      if (!size || line.some(c=>frames.some(r=>inside(r,(c.rect[0]+c.rect[2])/2,(c.rect[1]+c.rect[3])/2,1)))) return;
      // A numbered heading between text blocks may be absent from the parser.
      // Never recover text inside figure/table boxes, such as an axis title.
      const column=frames.find(r=>r[0]<=rect[0]+size && r[2]>=rect[2]-size &&
        (Math.abs(r[1]-rect[3])<size*4 || Math.abs(rect[1]-r[3])<size*4));
      if (!column) return;
      const centered=rect[0]-column[0]>size && Math.abs((column[2]-rect[2])-(rect[0]-column[0]))<size;
      result.push({paragraphType:"title",paragraphText:text,rects:[rect],inlineGlyphs:line,centered,
        minerUid:"pdf-heading:"+rect.join(",")});
    }
    for (const c of chars) {
      if (valid(c.rect) && !c.rotation && !c.diagonal) line.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) { if (line.length) finish(); line=[]; }
    }
    if (line.length) finish();
    return result;
  }

  function visualSources(sources, items, chars, view, rasterLabels) {
    for (const item of items) {
      const owner = item.id;
      const parts = item.captionFrames || [];
      for (const [i, f] of parts.entries())
        if (valid(f.bbox)) {
          sources.push({
            paragraphType: "caption",
            paragraphText: f.text,
            minerUid: String(owner) + ":caption:" + i,
            visualOwner: owner,
            bbox: f.bbox,
            physicalCaption: true, captionKind:f.role?.endsWith("_footnote")?"footnote":item.type==="table"?"table":"figure"
          });
        }
      if (item.type === "code" && !parts.length && item.code_caption?.length) {
        for (const [i, text] of item.code_caption.entries())
          if (typeof text === "string" && text.trim()) {
            sources.push({
              paragraphType: "caption",
              paragraphText: text,
              minerUid: String(owner) + ":caption:" + i,
              visualOwner: owner
            });
          }
      }
      if ((item.type === "table" && item.table_body) || (item.type === "code" && item.code_body)) {
        const region = fromPermille(item.bbox, view);
        const within = charactersIn(region, chars);
        const labels =
          item.type === "code"
            ? DeepRead.ParallelVisual.codeLabels(item, within)
            : DeepRead.ParallelVisual.labels(item, within);
        for (const [i, label] of labels.entries()) {
          sources.push({
            paragraphType: label.role || "table_label",
            paragraphText: label.source,
            inlineGlyphs: label.run,
            hint: label.hint,
            languagePairs: label.languagePairs,
            visualOwner: owner,
            minerUid: String(owner) + ":cell:" + i,
            rects: linesOf(label.run)
          });
        }
      }
    }
    for (const [i, label] of rasterLabels.entries()) {
      if (!valid(label.rect) || !valid(label.mask)) continue;
      let owner = items.find(
        (it) =>
          visual.has(it.type) &&
          inside(
            fromPermille(it.bbox, view),
            (label.mask[0] + label.mask[2]) / 2,
            (label.mask[1] + label.mask[3]) / 2,
            3
          )
      )?.id;
      const caption = sources.find(
        (p) =>
          (visual.has(p.paragraphType) || p.paragraphType === "caption") &&
          normalized(p.paragraphText) === normalized(label.text) &&
          inside(
            fromPermille(p.bbox, view),
            (label.rect[0] + label.rect[2]) / 2,
            (label.rect[1] + label.rect[3]) / 2,
            20
          )
      );
      if (caption) {
        caption.coveredByOCR = true;
        owner = caption.visualOwner ?? caption.minerUid;
      }
      sources.push({
        paragraphType: "figure_label",
        paragraphText: label.text,
        rects: [label.rect],
        inkMask: label.mask,
        typography: { fontSize: label.size },
        centered: !!label.centered,
        visualOwner: owner,
        hint: label.hint,
        minerUid: "figure-label:" + i
      });
    }
  }

  const contactLabels = { homepage: "主页", correspondence: "通信作者", date: "日期" };
  function contactTranslation(modelText, source, language) {
    if (!/^zh(?:-CN|-Hans)?$/iu.test(language)) return "";
    const prefix = /^\s*\*{0,3}(Homepage|Correspondence|Date)\s*:(?:\*{1,3})?\s*/iu.exec(modelText);
    if (!prefix) return "";
    const mail = /^Correspondence\s*:\s*[\w.%+'-]+@[\w.-]+\.[A-Za-z]{2,}\s*$/iu.test(source);
    if (!mail && !/^(?:⟦D+\d+⟧\s*)+[.。]?$/u.test(modelText.slice(prefix[0].length))) return "";
    return modelText.replace(prefix[1], contactLabels[prefix[1].toLowerCase()]).replace(/:/u, "：");
  }

  function splitFrontmatter(sources, chars, view, authorArea, saved) {
    const physicalSources = [];
    for (const p of sources) {
      // Publishing footers often put the citation and its DOI on separate
      // baselines, even when the parser returns one unbroken text string.
      if (["footer", "footnote", "page_footnote"].includes(p.paragraphType)) {
        const bounded = charactersIn(fromPermille(p.bbox, view), chars);
        const original = match(bounded, p.paragraphText);
        const groups = [];
        let line = [];
        for (const c of original) {
          line.push(c);
          if (c.lineBreakAfter || c.paragraphBreakAfter) {
            groups.push(line);
            line = [];
          }
        }
        if (line.length) groups.push(line);
        const isURL = (run) =>
          /^(?:(?:https?:\/\/|www\.)\S+|(?:DOI:\s*)?10\.\d{4,9}\/\S+)$/i.test(glyphStream(run).text.trim());
        if (groups.length > 1 && groups.some(isURL)) {
          const sections = [];
          for (const group of groups) {
            if (!isURL(group) && sections.length && !sections.at(-1).url) sections.at(-1).run.push(...group);
            else sections.push({ run: group.slice(), url: isURL(group) });
          }
          sections.forEach(({ run, url }, i) =>
            physicalSources.push({
              ...p,
              paragraphText: glyphStream(run).text.trim(),
              inlineGlyphs: run,
              rects: linesOf(run),
              verbatim: url,
              minerUid: String(p.minerUid) + ":field:" + i,
              translationLayout: null,
              points: []
            })
          );
          continue;
        }
      }
      // Some parsers flatten a centered byline, affiliation and email into a
      // single paragraph. Restore the printed baselines when the glyphs agree.
      if (p.paragraphType === "text" && authorArea(p) && !p.context &&
          /@|\s·\s/u.test(p.paragraphText) && !p.translationLayout?.units?.some(u=>u.translation) &&
          !p.points?.some(point=>point.translation)) {
        const bounded = charactersIn(fromPermille(p.bbox, view), chars);
        const pieces = p.paragraphText.split(/\s·\s/u);
        let run = match(bounded,pieces.join(" "));
        // Some first-page fields sit on opposite sides of the abstract.
        // Their merged parser box spans unrelated prose in between.
        if (!run.length && pieces.length>1) {
          const fields=pieces.map(part=>match(bounded,part));
          const assigned=fields.flat();
          if (fields.every(field=>field.length) && new Set(assigned).size===assigned.length) run=assigned;
        }
        const text = normalized(glyphStream(run).text);
        const cached = run.length && saved?.some(record=>{
          try { return record.text && normalized(JSON.parse(record.identity)[0]) === text; }
          catch { return false; }
        });
        const lines = linesOf(run);
        const hasContactFields = /(?:Homepage|Correspondence|Date)\s*:/iu.test(p.paragraphText);
        if ((!cached || hasContactFields) && lines.length > 1) {
          const fields = lines.map(rect=>charactersIn(rect,run));
          const assigned = fields.flat();
          if (fields.every(field=>field.length) && assigned.length===run.length && new Set(assigned).size===run.length) {
            for (const [i,field] of fields.entries()) {
              const text=glyphStream(field).text.trim();
              // The source identifies these as author names and affiliations.
              // Keep the original name spellings and markers in the PDF.
              const names=text.match(/\p{Lu}[\p{L}.'’\-]+\s+\p{Lu}[\p{L}.'’\-]+\s*[∗†‡*\d,]/gu);
              if (hasContactFields && names?.length>=3) continue;
              physicalSources.push({...p,paragraphText:text,inlineGlyphs:field,rects:[lines[i]],frontMatterLine:true,
                minerUid:String(p.minerUid)+":byline:"+i,translationLayout:null,points:[]});
            }
            continue;
          }
        }
      }
      const parts = String(p.paragraphText || "")
        .split(/\s*\n+\s*/u)
        .filter(Boolean);
      if (
        p.paragraphType === "text" &&
        parts.length > 1 &&
        (authorArea(p) || parts.every((t) => /^[\p{L} ]{2,18}:/u.test(t)))
      ) {
        const within = charactersIn(fromPermille(p.bbox, view), chars);
        const matches = parts.map((t) => match(within, t));
        if (matches.every((m) => m.length) && new Set(matches.flat()).size === matches.flat().length) {
          parts.forEach((t, i) =>
            physicalSources.push({
              ...p,
              paragraphText: t,
              inlineGlyphs: matches[i],
              rects: linesOf(matches[i]),
              minerUid: String(p.minerUid) + ":line:" + i,
              translationLayout: null,
              points: []
            })
          );
          continue;
        }
      }
      physicalSources.push(p);
    }
    return physicalSources;
  }

  // Cached paragraph IDs are physical IDs. A joined translation may cross a page or
  // an image, so only use its identified per-fragment text in a physical frame.
  function plan({
    paragraphs = [],
    items = [],
    chars = [],
    view,
    reuse = true,
    nativeParser = false,
    continuationFor,
    language = "zh",
    rasterLabels = [],
    saved = []
  }) {
    chars = DeepRead.ParallelFrames.repairScripts(DeepRead.Typography.composeAccents(chars));
    // Direct text-layer results have no service ids. Bind every recovered
    // figure label and caption to its actual visual owner on this page.
    const physicalItems = items.map((item,index) => item.id == null ? {...item,id:"item:"+index} : item);
    const recovered = DeepRead.ParallelFrames.recover(physicalItems, chars, view);
    items = recovered.items;
    paragraphs = paragraphs.filter(p => !recovered.replaced.has(p.minerUid));
    const units = [],
      barriers = [];
    const parsed = items.map(sourceParagraph);
    const primaryTitle = parsed.find((it) => it.docTitle)?.minerUid;
    // Cards can combine prose + a display equation + its explanation. For a
    // page translation the original parser frames own these three positions.
    const parsedIDs = new Set(parsed.map((p) => p.minerUid));
    const detailed = new Set(
      items.filter((it) => it.captionFrames?.length || it.parentId != null).map((it) => it.parentId ?? it.id)
    );
    const typed = new Map(parsed.map((p) => [p.minerUid, p]));
    const sources = paragraphs
      .filter(
        (p) => !detailed.has(p.minerUid) && (p.paragraphType !== "text_with_equation" || !parsedIDs.has(p.minerUid))
      )
      .map((p) => {
        const meta = typed.get(p.minerUid);
        return meta && ["ref_text", "title", "header", "footer", "page_footnote"].includes(meta.paragraphType)
          ? { ...p, paragraphType: meta.paragraphType, pageIndex: meta.pageIndex,headingLevel:meta.headingLevel }
          : p;
      });
    const used = new Set(sources.map((p) => p.minerUid).filter((id) => id != null));
    const known = new Set(sources.map((p) => JSON.stringify([normalized(p.paragraphText), p.bbox])));
    for (const p of parsed) {
      if (protectedTypes.has(p.paragraphType))
        barriers.push({ rect: fromPermille(p.bbox, view), owner: p.minerUid, estimatedGraphic:nativeParser && visual.has(p.paragraphType) });
      if (!used.has(p.minerUid) && !known.has(JSON.stringify([normalized(p.paragraphText), p.bbox])))
        sources.push(p);
    }
    sources.push(...uncoveredHeadings(sources, chars, view, recovered.tableBounds));
    visualSources(sources, items, chars, view, rasterLabels);
    const paperTitle = items.find((it) => it.page_idx === 0 && it.text_level === 1 && valid(it.bbox));
    const firstSection = items.find(
      (it) =>
        it.page_idx === 0 &&
        it.text_level > 0 &&
        /^(?:abstract|summary|\d*\.?\s*introduction)$/i.test(it.text?.trim())
    );
    const authorArea = (p) =>
      paperTitle &&
      p.pageIndex === 0 &&
      valid(p.bbox) &&
      p.bbox[1] >= paperTitle.bbox[3] - 3 &&
      p.bbox[1] < (firstSection?.bbox?.[1] ?? paperTitle.bbox[3] + 230);
    const physicalSources = splitFrontmatter(sources, chars, view, authorArea, saved);
    for (const p of joinSplitFormula(physicalSources, chars, view)) {
      if (p.coveredByOCR) continue;
      let type = p.paragraphType || "text";
      const caption = visual.has(type) || type === "caption";
      const existingRects = (p.rects || []).filter(valid);
      const region = union(existingRects) || fromPermille(p.bbox, view);
      const displayMath = /^(?:\$\$(?:(?!\$\$)[\s\S])+\$\$|\\\[(?:(?!\\\])[\s\S])+\\\])$/u.test(
        p.paragraphText?.trim() || ""
      );
      if ((!caption && !prose.has(type)) || displayMath) {
        if (region) barriers.push({ rect: region, owner: p.minerUid });
        continue;
      }
      if (!p.paragraphText?.trim()) continue;
      if (/^\s*[\w.%+'-]+@[\w.-]+\.[A-Za-z]{2,}\s*$/i.test(p.paragraphText)) continue;
      let bounded = charactersIn(region, chars);
      if (type === "header" && !bounded.length) continue; // journal logos can be single bitmaps
      if (
        authorArea(p) &&
        type === "text" &&
        !p.context &&
        DeepRead.ParallelVisual.isName(p.paragraphText) &&
        bounded.filter(DeepRead.Typography.bold).length > bounded.length * 0.55
      )
        continue;
      let ocr = DeepRead.ParallelInline.alignOCR(bounded, p.paragraphText);
      let glyphs = p.inlineGlyphs || (ocr ? bounded : match(bounded, p.paragraphText));
      if (!glyphs.length && existingRects.length && valid(p.bbox)) {
        const original = charactersIn(fromPermille(p.bbox, view), chars);
        ocr = DeepRead.ParallelInline.alignOCR(original, p.paragraphText);
        glyphs = ocr ? original : match(original, p.paragraphText);
        if (glyphs.length) bounded = original;
      }
      if (!glyphs.length && caption && !p.physicalCaption) glyphs = match(chars, p.paragraphText);
      if (type === "text" && glyphs.length && p.paragraphText.length < 120 &&
          /^(?:[A-Z]|\d+)(?:\.\d+)*\.?\s+\p{Lu}/u.test(p.paragraphText) &&
          !/[.!?]$/u.test(p.paragraphText) && glyphs.filter(DeepRead.Typography.bold).length > glyphs.length*.85)
        type = "title";
      const tag = equationTag(glyphs);
      if (tag) {
        barriers.push({ rect: tag.rect, owner: p.minerUid });
        glyphs = glyphs.slice(tag.end);
      }
      const stream = glyphStream(glyphs);
      const oldLayout = p.translationLayout?.units;
      let layout = oldLayout;
      if (!layout?.length || (layout.length === 1 && glyphs.length && type === "text")) {
        const current = DeepRead.TranslationLayout.analyze(stream.text || p.paragraphText, stream.mapping, glyphs, {
          type: type === "list" ? "list" : "text"
        }).units;
        if (!layout?.length || current.length > 1) layout = current;
      }
      if (["ref_text", "title", "code_comment", "table_label"].includes(type)) {
        layout = [
          { ...(layout.length === 1 ? layout[0] : {}), sourceText: p.paragraphText, kind: type, marker: "" }
        ];
      }
      if (reuse && p.points?.length && layout.some((u) => !u.translation)) {
        const restored = DeepRead.TranslationLayout.fromPoints({ version: 1, units: layout }, p);
        if (restored) layout = layout.map((u, i) => (u.translation ? u : restored.units[i]));
      }
      const pointTexts = (p.points || []).map((pt) => pt.translation?.trim());
      const pointTranslation = pointTexts.every(Boolean) ? pointTexts.join(" ") : "";
      const joined = reuse && continuationFor?.(p);
      const fragment = joined?.fragments?.find((part) => part.key === `p_${p.pageIndex}_${p.paragraphIndex}`)?.text;
      for (const u of layout) {
        const single = layout.length === 1;
        let source = u.sourceText || p.paragraphText;
        if (tag && source.startsWith(tag.label)) source = source.slice(tag.label.length).trimStart();
        const local = single ? glyphs : match(glyphs.length ? glyphs : bounded, source);
        const orient = local.find((c) => c.rotation != null)?.rotation || 0;
        let rects = orient && type==="figure_label" && local.length ? [union(local.map(c=>c.rect))] : linesOf(local);
        // Whole-figure boxes are not caption frames. For OCR-only prose a typed
        // text box is usable; never guess a split between unmapped list items.
        if (
          !rects.length &&
          (!caption || p.physicalCaption) &&
          single &&
          region &&
          !bounded.some((c) => glyphText(c).trim())
        ) {
          rects = existingRects.length ? existingRects : [region];
        }
        const rect = union(rects);
        const sourceSize = DeepRead.Typography.metrics(local)?.fontSize || p.typography?.fontSize || 0;
        const size =
          p.centered && local.length
            ? Math.max(...local.map((c) => c.fontSize || 0), sourceSize)
            : sourceSize || Math.min(caption ? 9 : 10, rect ? rect[3] - rect[1] : 10);
        const angle = (orient * Math.PI) / 180;
        // A parser can join the tail of one column to the head of another, or
        // enclose a floating object in the blank space between two text runs.
        // Such text is still translated but cannot safely cover this rectangle.
        const disconnected = rects.some(
          (r, i) =>
            i > 0 &&
            !orient &&
            (r[1] > rects[i - 1][3] + size * 2 ||
              rects[i - 1][1] - r[3] > size * 2.8 ||
              (Math.abs(r[3] - rects[i - 1][3]) < size * 0.5 && r[0] - rects[i - 1][2] > 3 * size))
        );
        const pitches = rects
          .slice(1)
          .map((r, i) => (rects[i][3] - r[3]) / size)
          .filter((n) => n > 0.7 && n < 2)
          .sort((a, b) => a - b);
        const firstBody = markerLength(local, u.marker);
        const modelGlyphs = type === "code_comment" || (orient && type==="figure_label") ? [] : local.slice(firstBody);
        const inline = DeepRead.ParallelInline.describe(
          modelGlyphs,
          withoutMarker(source, u.marker),
          type === "code_comment" ? source : withoutMarker(u.styledText, u.marker),
          size,
          language,
          ocr,
          type === "text" && authorArea(p),
          type === "title"
        );
        if (type === "table_label")
          for (const token of inline.tokens) {
            if (token.kind === "math" && /^[\p{Script=Greek}\p{Sm}]$/u.test(token.display)) token.kind = "literal";
          }
        // Some OCR engines label an isolated equation as text. It belongs to
        // the original artwork even if a neighbouring text box overlaps it.
        const words = inline.modelText
          .replace(/⟦D+\d+⟧/gu, "")
          .replace(/\b(?:log|ln|exp|sin|cos|tan|max|min)\b/gu, "");
        if (inline.tokens.some((t) => t.kind === "tex" || t.kind === "math") && !/[\p{L}\p{N}]/u.test(words)) {
          if (rect || region) barriers.push({ rect: rect || region, owner: p.minerUid });
          continue;
        }
        const bodyChars = local.filter((c) => glyphText(c).trim());
        const primaryFace = bodyChars.find((c) => c.fontSize >= size * 0.85)?.fontName || "";
        const fontFamily = DeepRead.PaperStyles?.sourceFamily(primaryFace);
        const block = {
          source,
          ...inline,
          marker: u.marker || "",
          indent: u.indentEm || 0,
          hanging: u.hangingEm || 0,
          rect,
          rects,
          size,
          direction: [Math.cos(angle), Math.sin(angle)],
          sourceBaseline: !orient ? firstBaseline(bodyChars,rects[0],size) : undefined,
          pitch: pitches[Math.floor(pitches.length / 2)],
          title: type === "title",
          caption,
          fontFamily,
          sans: fontFamily === "sans",
          allItalic: bodyChars.length > 0 && bodyChars.every(DeepRead.Typography.italic),
          boldTitle: !bodyChars.length || bodyChars.filter(DeepRead.Typography.bold).length > bodyChars.length / 2,
          owner: p.minerUid,
          matched: !!local.length,
          mixed:
            disconnected ||
            (type === "text_with_equation" && !local.length && !inline.tokens.some((t) => t.kind === "tex"))
        };
        block.visualOwner = p.visualOwner;
        block.role = type;
        block.headingLevel=p.headingLevel;
        block.layoutPart=p.layoutPart;
        block.captionKind=p.captionKind;
        block.frontMatter=authorArea(p) && type==="text" &&
          (p.frontMatterLine || p.verbatim || DeepRead.ParallelVisual.isName(p.paragraphText) ||
          (p.paragraphText.match(/\p{Lu}[\p{L}.’-]+\s+\p{Lu}[\p{L}.’-]+[\d,;¹²³∗†]/gu)||[]).length>=2 || /@|^\s*[\d*∗†‡]|\b(?:University|Institute|Laboratory)\b/u.test(p.paragraphText.slice(0,80)));
        if (p.flushLeft) block.flushLeft = true;
        block.verbatim = !!p.verbatim || !/[\p{L}\p{N}]/u.test(block.modelText.replace(/⟦D+\d+⟧/gu,""));
        block.context = p.context;
        block.hint = p.hint;
        block.documentTitle = type === "title" && primaryTitle != null && p.minerUid === primaryTitle;
        if (["table_label", "figure_label", "formula_note", "code_comment"].includes(type)) {
          block.caption = true;
          block.verifiedLabel = true;
        }
        if (type === "algorithm_step" && rects.length === 1) block.verifiedLabel = true;
        if (block.title || type === "code_comment" || type === "figure_label")
          block.styleSamples = local
            .filter((c) => valid(c.rect))
            .slice(0, 15)
            .map((c) => c.rect);
        if (rects.length === 1 && bodyChars.length > 0 && bodyChars.length <= 90) {
          block.linkSamples = local
            .slice(firstBody)
            .filter((c) => glyphText(c).trim() && valid(c.rect))
            .map((c) => c.rect);
        }
        if (p.inkMask) block.inkMask = p.inkMask;
        if (type === "ref_text" && rects.length > 1 && !orient) {
          const starts = rects
            .slice(1)
            .map((r) => r[0])
            .sort((a, b) => a - b);
          block.hanging = Math.max(0, (starts[Math.floor(starts.length / 2)] - rect[0]) / size);
          block.indent = Math.max(0, (rects[0][0] - rect[0]) / size);
        } else if (type === "ref_text") block.hanging = 0;
        if (block.allItalic && rects.length === 1 && /^[A-Z]\.$/u.test(block.marker)) block.title = true;
        const label = inline.tokens[0];
        block.centered = !!p.centered;
        if (rect && !orient && (type === "title" || authorArea(p) || type === "header")) {
          const middle = (rect[0] + rect[2]) / 2,
            pageMiddle = (view[0] + view[2]) / 2;
          const sameCenter = rects.every((r) => Math.abs((r[0] + r[2]) / 2 - middle) < size * 0.9);
          // A short translation keeps the same centre as a centred source
          // title/affiliation. Also recognize the centre of a single column.
          const centeredInColumn =
            type === "title" &&
            rects.length === 1 &&
            items.some((it) => {
              if (it.type !== "text" || it.text_level || !valid(it.bbox)) return false;
              const col = fromPermille(it.bbox, view);
              return (
                col[0] < rect[0] - size &&
                col[2] > rect[2] + size &&
                Math.abs(col[3] - rect[1]) < 4 * size &&
                Math.abs((col[0] + col[2]) / 2 - middle) < size * 0.65
              );
            });
          if (sameCenter && (Math.abs(middle - pageMiddle) < size * 0.8 || centeredInColumn)) block.centered = true;
        }
        if (
          block.title &&
          !block.marker &&
          ["number", "section"].includes(label?.kind) &&
          label.start === 0 &&
          label.rect
        ) {
          const following = bodyChars.find(
            (c) => c.rect?.[0] >= label.rect[2] - 0.1 && c.rect[2] > label.rect[2] + 0.1
          );
          if (following && following.rect[0] - label.rect[2] > size * 0.35)
            block.headingNumber = { id: label.id, width: following.rect[0] - label.rect[0] };
        }
        if (firstBody && rect && local[firstBody]?.rect && !orient) {
          block.markerRect = union(
            local
              .slice(0, firstBody)
              .filter((c) => glyphText(c).trim())
              .map((c) => c.rect)
              .filter(valid)
          );
          block.markerIndent = Math.max(0, (local[firstBody].rect[0] - rect[0]) / size);
          if (rects.length > 1) block.hanging = Math.max(0, (rects[1][0] - rect[0]) / size);
        }
        const old = reuse ? (single && fragment) || u.translation || (single ? pointTranslation : "") : "";
        const contact=(p.frontMatterLine || authorArea(p)) && contactTranslation(inline.modelText,source,language);
        if (contact) block.verbatim=true;
        const fixed = contact || (type === "table_label" &&
          DeepRead.ParallelVisual.compactLabel(source, language, p.languagePairs, inline.modelText));
        block.translation =
          fixed || (block.verbatim ? inline.modelText : DeepRead.ParallelInline.fromLegacy(block, old));
        units.push(block);
      }
    }
    const bbox = (r) => ({ left: r[0], top: r[1], right: r[2], bottom: r[3] });
    const { layoutRectsOverlap } = DeepRead.ParallelTypeset.engine().FitModelParts.rects;
    const overlaps = (a, b, tolerance) => layoutRectsOverlap(bbox(a), bbox(b), tolerance);
    for (const unit of units) {
      const r = unit.rect;
      const obstructed = (candidate, tolerance) =>
        barriers.some(
          (b) =>
            b.rect &&
            overlaps(candidate, b.rect, tolerance) &&
            !(b.estimatedGraphic && unit.caption && unit.matched && /^(?:Fig(?:ure)?\.?|Table|Tab\.)\s+\d+/iu.test(unit.source)) &&
            !(unit.caption && unit.matched && unit.owner != null && b.owner === unit.owner) &&
            !(unit.visualOwner != null && b.owner === unit.visualOwner && (unit.verifiedLabel || unit.matched))
        ) ||
        units.some((other) => other !== unit && valid(other.rect) && overlaps(candidate, other.rect, tolerance));
      // A short last line can lie beside the top of a display equation.
      // The glyph masks stay on that line; shorten the typesetting frame by
      // the small amount of clear leading occupied by the neighbouring box.
      if (valid(r) && unit.matched && unit.direction[0] > .99 && obstructed(r,.6)) {
        const near = Math.min(2.5,unit.size*.24);
        for (const side of [1,3]) {
          const edge = r[side], inner = side === 1 ? edge+near : edge-near;
          const candidate = r.slice();
          candidate[side] = inner;
          if (!valid(candidate) || obstructed(candidate,.6) || unit.rects.some(line=>obstructed(line,.6))) continue;
          r[side] = inner;
          break;
        }
      }
      unit.placed = !!(
        valid(r) &&
        inside(view, r[0], r[1], 1) &&
        inside(view, r[2], r[3], 1) &&
        !unit.mixed &&
        !obstructed(r, 0.6)
      );
      if (unit.placed) {
        if (unit.documentTitle && unit.direction[0] > 0.99) {
          const cap = unit.size * (unit.rects.length > 1 ? 0.46 : 0.18);
          let above = Math.min(cap, view[3] - r[3]),
            below = Math.min(cap, r[1] - view[1]);
          for (const c of chars) {
            const other = c.rect;
            if (!valid(other) || other[2] <= r[0] || other[0] >= r[2]) continue;
            if (other[1] >= r[3]) above = Math.min(above, Math.max(0, other[1] - r[3] - 1));
            if (other[3] <= r[1]) below = Math.min(below, Math.max(0, r[1] - other[3] - 1));
          }
          if (above && obstructed([r[0], r[3], r[2], r[3] + above], 0)) above = 0;
          if (below && obstructed([r[0], r[1] - below, r[2], r[1]], 0)) below = 0;
          unit.titleInsets = [above, below];
        }
        // The Latin glyph box can be shorter than one CJK em. Descenders may
        // use a little clear leading below it, without moving the paragraph top.
        const clearance = Math.min(2.2, unit.size * 0.22, r[1] - view[1]);
        if (clearance > 0 && !obstructed([r[0], r[1] - clearance, r[2], r[1]], 0)) unit.clearance = clearance;
        // PDF text-layer metrics can fall just inside the ink, especially italic tails.
        // Allow a narrow bleed on the background only when no neighbouring frame is hit.
        const pad = unit.matched ? Math.min(1.3, unit.size * 0.12) : 0;
        unit.masks = unit.inkMask
          ? [unit.inkMask]
          : unit.rects.map((line) => {
              const mask = [
                Math.max(view[0], line[0] - pad),
                Math.max(view[1], line[1] - pad),
                Math.min(view[2], line[2] + pad),
                Math.min(view[3], line[3] + pad)
              ];
              // Some embedded fonts report a box for just the middle of the
              // letters. Keep the text anchor, but erase the caps and descenders
              // that fall outside the narrow box on the PDF canvas.
              if (
                pad && unit.direction[0] > 0.99 && !unit.verifiedLabel &&
                (unit.role === "text" || unit.title || unit.caption) &&
                line[3] - line[1] < unit.size * 0.58
              ) {
                const extent = [
                  mask[0],
                  Math.max(view[1], line[1] - unit.size * 0.28),
                  mask[2],
                  Math.min(view[3], line[3] + unit.size * 0.39)
                ];
                if (!obstructed(extent, 0)) return extent;
              }
              return obstructed(mask, 0) ? line : mask;
            });
        // The column measure is the common edge of full lines. Optical
        // punctuation can protrude slightly beyond it; the last line is free.
        const ends = unit.rects.slice(0,-1).map(line=>line[2]).sort((a,b)=>a-b);
        const edge = ends[Math.floor((ends.length-1)/2)];
        const tolerance = unit.size*0.30;
        unit.justified = ends.length>=2 && unit.direction[0]>.99 &&
          r[2]-edge<=unit.size*.55 && ends.filter(x=>Math.abs(x-edge)<=tolerance).length>ends.length/2;
        if (unit.justified) unit.columnRight=edge;

      }
    }
    const bodyPitches = new Map();
    const styleKey = (u) => Math.round(u.size * 2);
    for (const u of units) {
      if (u.title || u.caption || !u.pitch) continue;
      const key = styleKey(u);
      if (!bodyPitches.has(key)) bodyPitches.set(key, []);
      bodyPitches.get(key).push(u.pitch);
    }
    for (const pitches of bodyPitches.values()) pitches.sort((a, b) => a - b);
    for (const u of units) {
      const samples = bodyPitches.get(styleKey(u));
      u.bodyPitch = samples?.length ? samples[Math.floor(samples.length / 2)] : 1.2;
    }
    return units;
  }

  const identity = (u) => JSON.stringify([u.source, u.styled, u.rect, u.marker]);
  const contract = u => JSON.stringify([u.modelText,(u.tokens || []).map(s=>[s.kind,s.source,s.display]),
    ...(u.context?.length || u.hint ? [u.context || null,u.hint || ""] : [])]);
  // v1.11 split interval endpoints into citation slots and could include
  // ", a 2D" in a glyph crop. Move only these verified boundaries in old records.
  function migrateInlineMath(unit, entry) {
    let previous;
    try {
      previous = JSON.parse(entry.contract);
    } catch {
      return "";
    }
    if (!Array.isArray(previous) || !Array.isArray(previous[1]) || !previous[1].length) return "";
    const [oldModel, oldTokens, ...context] = previous;
    if (
      typeof oldModel !== "string" ||
      JSON.stringify(context) !==
        JSON.stringify(unit.context?.length || unit.hint ? [unit.context || null, unit.hint || ""] : [])
    )
      return "";
    const pattern = /⟦D+\d+⟧/gu,
      oldIDs = oldModel.match(pattern) || [],
      tokens = unit.tokens || [];
    if (
      oldIDs.length !== oldTokens.length ||
      !oldTokens.every((t) => Array.isArray(t) && typeof t[1] === "string")
    )
      return "";
    const compact = (t) => t.replace(/\s+/gu, "");
    const expand = (model, list) => {
      let i = 0;
      return compact(model.replace(pattern, () => list[i++] || ""));
    };
    if (
      expand(
        oldModel,
        oldTokens.map((t) => t[1])
      ) !==
      expand(
        unit.modelText,
        tokens.map((t) => t.source)
      )
    )
      return "";
    const replyIDs = typeof entry.text === "string" ? entry.text.match(pattern) || [] : [];
    if (replyIDs.length !== oldIDs.length || !oldIDs.every((id) => replyIDs.includes(id))) return "";
    const ids = new Map(),
      pairs = new Map();
    let j = 0;
    for (let i = 0; i < oldTokens.length; i++, j++) {
      const [kind, source, display] = oldTokens[i],
        t = tokens[j];
      if (!t) return "";
      if (t.kind === kind && t.source === source && t.display === display) {
        ids.set(oldIDs[i], t.id);
        continue;
      }
      if (t.kind !== "math" || kind !== "math") return "";
      const next = oldTokens[i + 1];
      if (
        /[∈∉]$/u.test(source.trimEnd()) &&
        next?.[0] === "citation" &&
        compact(t.source) === compact(source + next[1])
      ) {
        pairs.set(oldIDs[i], oldIDs[i + 1]);
        ids.set(oldIDs[i], t.id);
        i++;
        continue;
      }
      const dimension = /,\s*a\s+([23])D$/u.exec(source);
      if (
        dimension &&
        /^zh(?:-|$)/iu.test(unit.language) &&
        compact(source.slice(0, dimension.index)) === compact(t.source) &&
        tokens[j + 1]?.kind === "number" &&
        tokens[j + 1].source === dimension[1]
      ) {
        ids.set(oldIDs[i], t.id + "，" + tokens[++j].id + "D");
        continue;
      }
      return "";
    }
    if (j !== tokens.length || !entry.text) return "";
    let text = entry.text;
    for (const [id, next] of pairs) {
      const adjacent = new RegExp(id + "\\s*" + next, "u");
      if (!adjacent.test(text)) return "";
      text = text.replace(adjacent, id);
    }
    text = text.replace(pattern, (id) => ids.get(id) || id);
    return DeepRead.ParallelInline.valid(unit, text) ? text : "";
  }

  function hydrate(units, entries) {
    const bySource = new Map((entries || []).map((e) => [e.identity, e]));
    // Before protected expressions, style detection and the last punctuation
    // glyph were part of the cache key. Recover only one matching physical frame.
    const legacy = new Map();
    for (const entry of entries || []) {
      if (entry.contract) continue;
      let parts;
      try { parts = JSON.parse(entry.identity); } catch { continue; }
      if (!Array.isArray(parts) || !valid(parts[2])) continue;
      const key = JSON.stringify([parts[0], parts[3]]);
      if (!legacy.has(key)) legacy.set(key, []);
      legacy.get(key).push({ rect: parts[2], entry });
    }
    for (const u of units) {
      let cached = bySource.get(identity(u));
      if (u.translation && DeepRead.ParallelInline.valid(u,u.translation)) {
        if (cached?.replaces === u.translation && cached.contract === contract(u) && DeepRead.ParallelInline.valid(u,cached.text)) {
          u.termBase=u.translation;
          u.translation=cached.text;
        }
        continue;
      }
      u.translation="";
      if (!cached && valid(u.rect)) {
        const candidates = (legacy.get(JSON.stringify([u.source, u.marker])) || []).filter(({rect}) =>
          u.rect.every((v, i) => Math.abs(v - rect[i]) <= (i === 2 ? u.size * 1.15 : 0.75)));
        if (candidates.length === 1) cached = candidates[0].entry;
      }
      if (!cached) continue;
      if (cached.contract === contract(u) && DeepRead.ParallelInline.valid(u,cached.text)) {
        u.translation=cached.text;
        if (cached.replaces) u.termBase=cached.replaces;
      }
      else if (!cached.contract) u.translation=DeepRead.ParallelInline.fromLegacy(u,cached.text);
      else u.translation=migrateInlineMath(u,cached);
    }
  }
  function records(units) {
    return units.filter((u) => u.translation).map((u) => ({ identity: identity(u), contract: contract(u), text: u.translation,
      ...(u.termBase ? {replaces:u.termBase} : {}) }));
  }

  function interruptedContext(items, pageIndex) {
    const nearby = items.filter((item) => Math.abs(item.page_idx - pageIndex) <= 1).map((item, i) => {
      const p = sourceParagraph(item, i);
      return { page_idx: item.page_idx, paragraph_idx: i, paragraph_text: p.paragraphText, paragraph_type: p.paragraphType, bbox: p.bbox };
    });
    const bySource = new Map();
    for (const group of DeepRead.Continuations.candidates(nearby)) {
      const texts = group.parts.map((p) => p.paragraph_text);
      for (const p of group.parts) if (p.page_idx === pageIndex) bySource.set(normalized(p.paragraph_text), texts);
    }
    return bySource;
  }

  function setContext(units, context) {
    const edge = (value, end) => {
      const sentences = value.trim().match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu) || [];
      const sentence = end ? sentences.at(-1) : sentences[0];
      return end ? sentence?.trim().slice(-180) : sentence?.trim().slice(0,180);
    };
    for (const u of units) {
      const own=normalized(u.source), fragments=u.context || context?.get(own) || [];
      const index=fragments.findIndex(s=>normalized(s)===own);
      if (index<0) continue;
      const before=index>0 ? fragments[index-1] : "";
      const after=index+1<fragments.length ? fragments[index+1] : "";
      u.before=edge(before,true);
      u.after=edge(after,false);
      // Keep numbers from the full neighbour locally as a cross-frame check.
      // Only a short boundary sentence is sent to the translator.
      const original=DeepRead.ParallelInline.numbers(u.source);
      const neighbour=DeepRead.ParallelInline.numbers(before+" "+after);
      u.foreignNumbers=[...neighbour].filter(n=>!original.has(n));
    }
  }

  function coversProse(unit, text) {
    if (
      !/^zh(?:-|$)/iu.test(unit.language || "") ||
      unit.title ||
      unit.verbatim ||
      (unit.role &&
        !["text", "text_with_equation", "list", "caption", "image", "table", "figure", "chart"].includes(
          unit.role
        ))
    )
      return true;
    // Detect a paragraph returned as a short abstract. Test only unlocked
    // prose, since a long formula or bibliography entry may remain verbatim.
    const prose = (unit.modelText || unit.source || "").replace(/⟦D+\d+⟧/gu, " ");
    const words = prose.match(/\b[A-Za-z][A-Za-z'-]+\b/gu)?.length || 0;
    if (words < 24) return true;
    const output = text.replace(/⟦D+\d+⟧/gu, " ");
    const han = output.match(/\p{Script=Han}/gu)?.length || 0;
    const retained = output.match(/\b[A-Za-z0-9][A-Za-z0-9'-]*\b/gu)?.length || 0;
    return han + Math.min(retained, words / 4) >= words * 0.58;
  }

  async function translate(units, { language, signal, request, context, concurrency = 1, onProgress, preview=false }) {
    setContext(units,context);
    const copies = new Map(), pending = [];
    for (const u of units) {
      if (u.translation) continue;
      const key = JSON.stringify([u.source,u.role,u.marker,contract(u),context?.get(normalized(u.source))]);
      if (!copies.has(key)) { copies.set(key, []); pending.push(u); }
      copies.get(key).push(u);
    }
    const matches = new Map([...copies.values()].map(group => [group[0],group]));
    const batches = [];
    let batch = [], cost = 0;
    for (const u of pending) {
      const length = (u.modelText || u.styled || u.source).length +
        (u.tokens || []).reduce((n, t) => n + t.source.length + t.display.length + 24, 0);
      if (batch.length && (batch.length >= 6 || cost + length > 3600)) {
        batches.push(batch);
        batch = [];
        cost = 0;
      }
      batch.push(u);
      cost += length;
    }
    if (batch.length) batches.push(batch);
    const accepted = new Map();
    async function attempt(group, repair) {
      const rows = group.map((u, i) => ({
        id: i + ":u0", kind: u.marker ? "list-item" : (u.role || "paragraph"),
        source_text: u.modelText || u.styled || u.source,
        ...(u.rects?.length>=2 && (u.title || u.caption || u.role==="text") ? {source_lines:u.rects.length} : {}),
        ...(u.title ? {kind:"heading"} : {}),
        ...(u.hint ? {source_context:u.hint} : {}),
        ...(!repair && u.before ? {preceding_context:u.before} : {}),
        ...(!repair && u.after ? {following_context:u.after} : {}),
        ...(u.tokens?.length ? { protected:u.tokens.map(t => ({id:t.id,source:t.source,meaning:t.display})) } : {})
      }));
      const replies = await DeepRead.TranslationLayout.requestUnits(rows, { request, targetLang: language, signal, repair });
      const missing = [], changed = [];
      for (const [i,u] of group.entries()) {
        const candidates = replies.filter(r => r.id === rows[i].id);
        const text = candidates.length === 1 && candidates[0].translation;
        if (!DeepRead.ParallelInline.valid(u,text) || !coversProse(u,text)) {missing.push(u);continue;}
        const cleaned = DeepRead.TranslationLayout.accept({units:[{id:"u0",marker:u.marker}]}, [{unit_id:"u0",translation:text}]).units[0].translation;
        for (const copy of matches.get(u)) {
          accepted.set(copy, cleaned);
          if (onProgress) { copy.translation = cleaned; changed.push(copy); }
        }
      }
      if (changed.length) await onProgress(changed);
      return missing;
    }
    // A dense mathematical passage can repeatedly lose a protected token.
    // Translate its word spans with the entire sentence for context. The
    // renderer restores the source expressions and emphasis in their own slots.
    async function recoverParts(u) {
      const parts=(u.modelText || u.styled || u.source).split(/(⟦D+\d+⟧|\*{1,3})/u);
      if (parts.length<3) return "";
      const slots=[];
      for (const [i,part] of parts.entries()) {
        if (i%2 || !/[\p{L}]{2}/u.test(part) || /^[\s\p{P}A-Z\d]+$/u.test(part)) continue;
        slots.push({id:String(i)+":u0",kind:u.role || "paragraph",source_text:part.trim()});
      }
      if (!slots.length) return "";
      for (let start=0; start<slots.length; start+=8) {
        const rows=slots.slice(start,start+8);
        const translated=await DeepRead.TranslationLayout.requestUnits(rows,{request,targetLang:language,signal,repair:true,
          context:[[u.modelText || u.source]]});
        for (const row of rows) {
          const result=translated.filter(t=>t.id===row.id);
          const value=result.length===1 && result[0].translation;
          if (!DeepRead.ParallelInline.valid({language,modelText:row.source_text},value) || /⟦D+\d+⟧|\*{2}/u.test(value)) return "";
          const i=parseInt(row.id,10), original=parts[i];
          parts[i]=original.match(/^\s*/u)[0]+value.trim()+original.match(/\s*$/u)[0];
        }
      }
      const text=parts.join("");
      return DeepRead.ParallelInline.valid(u,text) && coversProse(u,text) ? text : "";
    }
    let next = 0, failure, incomplete = 0;
    async function worker() {
      while (next < batches.length && !failure && !signal?.aborted) {
        const group = batches[next++];
        try {
          const missing = await attempt(group, false);
          if (!missing.length || preview) continue;
          const remaining = await attempt(missing,true);
          for (const u of remaining) {
            const recovered = await recoverParts(u);
            if (!recovered) { incomplete++; continue; }
            for (const copy of matches.get(u)) {
              accepted.set(copy,recovered);
              if (onProgress) copy.translation=recovered;
            }
            if (onProgress) await onProgress(matches.get(u));
          }
        } catch (error) { failure ||= error; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name:"AbortError" });
    if (failure) throw failure;
    if (incomplete) {
      const error=new Error(DeepRead.bilingual(`还有 ${incomplete} 处缺少完整译文。`, `${incomplete} passages still need translation.`));
      error.incomplete=true;
      throw error;
    }
    for (const [u, text] of accepted) u.translation = text;
  }
  DeepRead.ParallelPage = { fromPermille, plan, hydrate, records, translate, interruptedContext, setContext };
})();
